import fs from "node:fs/promises";
import path from "node:path";
import { BridgeError } from "./protocol.js";
import { fileTimestamp, sanitizeFilename } from "./util.js";

const SCREENSHOT_MAX_BYTES = 50 * 1024 * 1024;
const PDF_MAX_BYTES = 100 * 1024 * 1024;

/**
 * Converts base64 payloads from the extension into files on disk and returns
 * paths. Keeping binary data out of the model context is a core design rule.
 */
export class OutputStore {
  constructor({ baseDir, logger }) {
    this.baseDir = baseDir;
    this.logger = logger;
    this.screenshotDir = path.join(baseDir, "kai-webbridge-screenshots");
    this.pdfDir = path.join(baseDir, "kai-webbridge-pdfs");
  }

  async process(action, data, args = {}) {
    if (action === "screenshot") return this.#writeScreenshot(data, args);
    if (action === "save_as_pdf") return this.#writePdf(data, args);
    if (data && data.screenshot && typeof data.screenshot.data === "string") {
      const screenshot = await this.#writeScreenshot(data.screenshot, args);
      return {
        ...data,
        screenshot: {
          ...screenshot,
          full_page: data.screenshot.full_page === true,
        },
        screenshot_path: screenshot.path,
      };
    }
    return data;
  }

  async #writeScreenshot(data, args) {
    if (!data || typeof data.data !== "string" || !data.data) {
      throw new BridgeError("output_error", "extension returned no screenshot data");
    }
    const format = data.format === "jpeg" ? "jpeg" : "png";
    const mimeType = data.mimeType || (format === "jpeg" ? "image/jpeg" : "image/png");
    const buffer = Buffer.from(data.data, "base64");
    if (buffer.length === 0) throw new BridgeError("output_error", "screenshot data was empty");
    if (buffer.length > SCREENSHOT_MAX_BYTES) {
      throw new BridgeError("output_error", `screenshot is too large (${buffer.length} bytes)`);
    }
    const target =
      typeof args.path === "string" && args.path.trim()
        ? path.resolve(args.path)
        : path.join(this.screenshotDir, `screenshot_${fileTimestamp()}.${format === "jpeg" ? "jpg" : "png"}`);
    await this.#write(target, buffer);
    return {
      format,
      path: target,
      sizeBytes: buffer.length,
      mimeType,
    };
  }

  async #writePdf(data, args) {
    if (!data || typeof data.data !== "string" || !data.data) {
      throw new BridgeError("output_error", "extension returned no PDF data");
    }
    const buffer = Buffer.from(data.data, "base64");
    if (buffer.length === 0) throw new BridgeError("output_error", "PDF data was empty");
    if (buffer.length > PDF_MAX_BYTES) {
      throw new BridgeError("output_error", `PDF is too large (${buffer.length} bytes; limit is 100 MB)`);
    }
    const pageTitle = typeof data.pageTitle === "string" ? data.pageTitle : "page";
    const fallbackName = `${sanitizeFilename(pageTitle, "page")}.pdf`;
    const target =
      typeof args.path === "string" && args.path.trim()
        ? path.resolve(args.path)
        : path.join(this.pdfDir, fallbackName);
    await this.#write(target, buffer);
    return {
      path: target,
      sizeBytes: buffer.length,
      mimeType: "application/pdf",
      pageTitle,
    };
  }

  async #write(target, buffer) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, buffer);
    this.logger?.debug(`wrote ${buffer.length} bytes to ${target}`);
  }
}
