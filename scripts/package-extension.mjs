#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXTENSION = path.join(ROOT, "extension");
const DIST = path.join(ROOT, "dist");
const manifest = JSON.parse(fs.readFileSync(path.join(EXTENSION, "manifest.json"), "utf8"));

for (const icon of Object.values(manifest.icons ?? {})) {
  if (!fs.existsSync(path.join(EXTENSION, icon))) {
    throw new Error(`missing icon ${icon}; run the icon generator or restore extension/icons`);
  }
}

fs.mkdirSync(DIST, { recursive: true });
const output = path.join(DIST, `kai-webbridge-extension-${manifest.version}.zip`);
fs.rmSync(output, { force: true });

const result = spawnSync("zip", ["-qr", output, ".", "-x", "*.DS_Store"], {
  cwd: EXTENSION,
  stdio: "inherit",
});
if (result.status !== 0) throw new Error("zip failed; install zip and retry");

const check = spawnSync("unzip", ["-l", output], { encoding: "utf8" });
if (check.status !== 0 || !check.stdout.includes("manifest.json")) {
  throw new Error("packaged ZIP is missing manifest.json");
}

const size = fs.statSync(output).size;
process.stdout.write(`${output}\n${(size / 1024).toFixed(1)} KiB\n`);
