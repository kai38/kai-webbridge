import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OutputStore } from "../../src/outputs.js";

const logger = { debug() {}, error() {}, warn() {}, info() {} };

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "kwb-output-"));
}

test("screenshot data becomes a file and the base64 is removed", async () => {
  const dir = await tempDir();
  const store = new OutputStore({ baseDir: dir, logger });
  const data = Buffer.from("fake-png-bytes").toString("base64");
  const result = await store.process("screenshot", { format: "png", data, mimeType: "image/png" }, {});
  assert.equal(result.sizeBytes, 14);
  assert.equal(result.mimeType, "image/png");
  assert.match(result.path, /kai-webbridge-screenshots/);
  assert.equal(await fs.readFile(result.path, "utf8"), "fake-png-bytes");
  assert.equal(result.data, undefined);
});

test("a caller-supplied path is honored verbatim", async () => {
  const dir = await tempDir();
  const store = new OutputStore({ baseDir: dir, logger });
  const target = path.join(dir, "nested", "shot.jpg");
  const result = await store.process(
    "screenshot",
    { format: "jpeg", data: Buffer.from("x").toString("base64") },
    { path: target },
  );
  assert.equal(result.path, target);
  assert.equal((await fs.stat(target)).size, 1);
});

test("pdf filenames are sanitized and capped", async () => {
  const dir = await tempDir();
  const store = new OutputStore({ baseDir: dir, logger });
  const result = await store.process(
    "save_as_pdf",
    { data: Buffer.from("%PDF-1.4").toString("base64"), pageTitle: "../evil:name?" },
    {},
  );
  assert.match(result.path, /kai-webbridge-pdfs/);
  assert.match(result.path, /evil_name_\.pdf$/);
  assert.equal(result.mimeType, "application/pdf");
});

test("empty payloads are rejected", async () => {
  const dir = await tempDir();
  const store = new OutputStore({ baseDir: dir, logger });
  await assert.rejects(() => store.process("screenshot", { data: "" }, {}), /no screenshot data/);
  await assert.rejects(() => store.process("save_as_pdf", {}, {}), /no PDF data/);
});
