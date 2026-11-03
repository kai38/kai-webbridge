#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CACHE = path.join(ROOT, ".cache");

function platformKey() {
  if (process.platform === "linux" && process.arch === "x64") return { key: "linux64", label: "linux64" };
  if (process.platform === "darwin" && process.arch === "arm64") return { key: "mac-arm64", label: "mac-arm64" };
  if (process.platform === "darwin") return { key: "mac-x64", label: "mac-x64" };
  if (process.platform === "win32") return { key: "win64", label: "win64" };
  throw new Error(`unsupported platform: ${process.platform}/${process.arch}`);
}

async function main() {
  const { key, label } = platformKey();
  const target = path.join(CACHE, `chrome-for-testing-${label}`);
  const binary = path.join(target, process.platform === "win32" ? "chrome.exe" : "chrome");
  if (fs.existsSync(binary)) {
    process.stdout.write(`${binary}\n`);
    return;
  }

  const response = await fetch(
    "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json",
  );
  if (!response.ok) throw new Error(`cannot read Chrome for Testing versions: HTTP ${response.status}`);
  const data = await response.json();
  const stable = data.channels.Stable;
  const download = stable.downloads.chrome.find((entry) => entry.platform === key);
  if (!download) throw new Error(`no Chrome for Testing build for ${key}`);

  await fsp.mkdir(CACHE, { recursive: true });
  const zipPath = path.join(CACHE, `chrome-for-testing-${label}.zip`);
  process.stdout.write(`downloading Chrome for Testing ${stable.version} (${key})\n`);
  const binaryResponse = await fetch(download.url);
  if (!binaryResponse.ok) throw new Error(`download failed: HTTP ${binaryResponse.status}`);
  await fsp.writeFile(zipPath, Buffer.from(await binaryResponse.arrayBuffer()));

  process.stdout.write("extracting\n");
  if (process.platform === "win32") {
    const result = spawnSync(
      "powershell",
      ["-NoProfile", "-Command", `Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${CACHE}'`],
      { stdio: "inherit" },
    );
    if (result.status !== 0) throw new Error("Expand-Archive failed");
    const extracted = path.join(CACHE, `chrome-${key}`);
    await fsp.rm(target, { recursive: true, force: true });
    await fsp.rename(extracted, target);
  } else {
    const result = spawnSync("unzip", ["-q", "-o", zipPath, "-d", CACHE], { stdio: "inherit" });
    if (result.status !== 0) throw new Error("unzip failed (install unzip or extract manually)");
    await fsp.rm(target, { recursive: true, force: true });
    await fsp.rename(path.join(CACHE, `chrome-${key}`), target);
  }
  await fsp.rm(zipPath, { force: true });
  process.stdout.write(`${binary}\n`);
}

main().catch((error) => {
  process.stderr.write(`fetch-chrome: ${error.message}\n`);
  process.exitCode = 1;
});
