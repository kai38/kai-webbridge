import { timingSafeEqual } from "node:crypto";

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

export function createLogger(level = "info", stream = process.stderr) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const write = (lvl, args) => {
    if ((LEVELS[lvl] ?? 0) > threshold) return;
    const ts = new Date().toISOString();
    stream.write(`${ts} [${lvl}] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`);
  };
  return {
    error: (...a) => write("error", a),
    warn: (...a) => write("warn", a),
    info: (...a) => write("info", a),
    debug: (...a) => write("debug", a),
  };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(fn, { timeoutMs = 5000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  if (lastError) throw lastError;
  return null;
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function truncate(value, max) {
  if (typeof value !== "string") return value;
  return value.length <= max ? value : `${value.slice(0, max)}\n… [truncated ${value.length - max} chars]`;
}

export function sanitizeFilename(name, fallback = "file") {
  const cleaned = String(name ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 120);
  return cleaned || fallback;
}

export function fileTimestamp(date = new Date()) {
  const pad = (n, width = 2) => String(n).padStart(width, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}_` +
    `${pad(date.getMilliseconds(), 3)}`
  );
}

export function jsonByteLength(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return 0;
  }
}
