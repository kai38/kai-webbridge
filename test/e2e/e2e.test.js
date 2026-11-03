import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EXTENSION = path.join(ROOT, "extension");
const BIN = path.join(ROOT, "bin", "kai-webbridge.js");
const PORT = Number(process.env.KWB_E2E_PORT ?? 10087);
const BASE = `http://127.0.0.1:${PORT}`;
const CACHE_CHROME = path.join(
  ROOT,
  ".cache",
  `chrome-for-testing-${process.platform === "darwin" ? (process.arch === "arm64" ? "mac-arm64" : "mac-x64") : process.platform === "win32" ? "win64" : "linux64"}`,
  process.platform === "win32" ? "chrome.exe" : "chrome",
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, { timeoutMs = 20000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
      last = value;
    } catch (error) {
      last = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting (${last instanceof Error ? last.message : "no result"})`);
}

function pickChrome() {
  const candidates = [process.env.CHROME_BIN, CACHE_CHROME, "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean);
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    let version = "";
    try {
      version = execFileSync(candidate, ["--version"], { encoding: "utf8" }).trim();
    } catch {
      continue;
    }
    const major = Number(/(\d+)/.exec(version)?.[1] ?? 0);
    // Google Chrome 137+ ignores --load-extension; Chrome for Testing keeps it.
    if (candidate === "/usr/bin/google-chrome" || candidate === "/usr/bin/chromium") {
      if (major >= 137) continue;
    }
    return { path: candidate, version };
  }
  return null;
}

async function command(action, args = {}, session = "e2e") {
  const response = await fetch(`${BASE}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, args, session }),
  });
  return response.json();
}

async function ok(action, args = {}, session = "e2e") {
  const envelope = await command(action, args, session);
  assert.equal(envelope.ok, true, `${action} failed: ${JSON.stringify(envelope.error)}`);
  return envelope.data;
}

test("end-to-end: real Chrome, extension, snapshot, click, fill, screenshot, PDF", { timeout: 240000 }, async (t) => {
  const chrome = pickChrome();
  if (!chrome) {
    t.skip("Chrome for Testing not found; run `npm run fetch-chrome`");
    return;
  }
  const already = await fetch(`${BASE}/status`).then((r) => r.json()).catch(() => null);
  if (already?.running) {
    t.skip(`a daemon is already listening on ${BASE}; stop it before running e2e`);
    return;
  }

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "kwb-e2e-"));
  const profile = path.join(tmp, "profile");
  const home = path.join(tmp, "home");
  const daemonLog = fs.openSync(path.join(tmp, "daemon.log"), "a");
  const chromeLog = fs.openSync(path.join(tmp, "chrome.log"), "a");

  const pageServer = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (pathname === "/second.html") {
      res.end("<!doctype html><title>Second</title><h1>Second page</h1><p>network target</p>");
    } else {
      res.end(`<!doctype html><title>Kai E2E</title>
        <h1>Kai WebBridge E2E</h1>
        <label for="name">Name</label><input id="name" placeholder="Your name">
        <button id="greet" onclick="document.getElementById('out').textContent='Hello '+document.getElementById('name').value">Greet</button>
        <div id="out">waiting</div>
        <a id="link" href="/second.html">Second page</a>`);
    }
  });
  pageServer.listen(0, "127.0.0.1");
  await new Promise((resolve) => pageServer.once("listening", resolve));
  const pagePort = pageServer.address().port;

  const daemon = spawn(process.execPath, [BIN, "serve", `--port=${PORT}`, "--log-level=error"], {
    env: { ...process.env, KAI_WEBRIDGE_HOME: home },
    stdio: ["ignore", daemonLog, daemonLog],
  });

  let browser = null;
  t.after(async () => {
    try {
      if (browser?.pid) process.kill(-browser.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    try {
      daemon.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    await new Promise((resolve) => pageServer.close(resolve));
    fs.closeSync(daemonLog);
    fs.closeSync(chromeLog);
    if (!process.env.KWB_KEEP_TMP) await fsp.rm(tmp, { recursive: true, force: true });
  });

  await waitFor(async () => (await fetch(`${BASE}/status`).then((r) => r.json())).running, { timeoutMs: 10000 });
  await fsp.mkdir(profile, { recursive: true });

  browser = spawn(
    chrome.path,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profile}`,
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
      "about:blank",
    ],
    { detached: true, stdio: ["ignore", chromeLog, chromeLog] },
  );

  await waitFor(
    async () => {
      const status = await fetch(`${BASE}/status`).then((r) => r.json());
      return status.extension_connected === true;
    },
    { timeoutMs: 30000, intervalMs: 300 },
  );

  const navigated = await ok("navigate", {
    url: `http://127.0.0.1:${pagePort}/`,
    newTab: true,
    group_title: "Kai E2E",
  });
  assert.ok(Number.isInteger(navigated.tabId));

  const found = await ok("find_tab", { url: "127.0.0.1" });
  assert.equal(found.tabId, navigated.tabId);

  const snapshot = await ok("snapshot", { format: "aria" });
  assert.match(snapshot.tree_text, /button "Greet"/);
  assert.match(snapshot.tree_text, /textbox "Name"/);
  const buttonRef = /button "Greet" \[ref=(e\d+)\]/.exec(snapshot.tree_text)?.[1];
  const inputRef = /textbox "Name" \[ref=(e\d+)\]/.exec(snapshot.tree_text)?.[1];
  assert.ok(buttonRef && inputRef, "snapshot should expose refs");

  await ok("fill", { selector: `@${inputRef}`, value: "Kai" });
  await ok("click", { selector: `@${buttonRef}` });
  const out = await ok("evaluate", { code: "document.getElementById('out').textContent" });
  assert.equal(out.value, "Hello Kai");

  await ok("evaluate", {
    code: "(()=>{const d=document.createElement('div');d.id='ce';d.contentEditable='true';document.body.appendChild(d);return true})()",
  });
  const ce = await ok("fill", { selector: "#ce", value: "rich text" });
  assert.equal(ce.mode, "contenteditable");
  const ceText = await ok("evaluate", { code: "document.getElementById('ce').textContent" });
  assert.equal(ceText.value, "rich text");

  const shot = await ok("screenshot", { format: "jpeg", quality: 60 });
  assert.ok(fs.statSync(shot.path).size > 1000);
  assert.match(shot.path, /kai-webbridge-screenshots/);

  const elementShot = await ok("screenshot", { format: "png", selector: `@${buttonRef}` });
  assert.ok(fs.statSync(elementShot.path).size > 200);

  const interactive = await ok("snapshot", { format: "aria", interactive: true });
  assert.match(interactive.tree_text, /button "Greet"/);
  assert.doesNotMatch(interactive.tree_text, /text: Kai WebBridge E2E/);

  const jsonTree = await ok("snapshot", { format: "json" });
  assert.ok(Array.isArray(jsonTree.tree) && jsonTree.tree.length > 0);

  const pdf = await ok("save_as_pdf", { paper_format: "a4" });
  const pdfBytes = await fsp.readFile(pdf.path);
  assert.equal(pdfBytes.subarray(0, 4).toString(), "%PDF");

  await ok("network", { cmd: "start" });
  await ok("navigate", { url: `http://127.0.0.1:${pagePort}/second.html` });
  const list = await ok("network", { cmd: "list", filter: "second" });
  assert.ok(list.count >= 1, "network capture should see the second page request");
  const detail = await ok("network", { cmd: "detail", requestId: list.requests[0].requestId });
  assert.match(detail.body ?? "", /Second page/);

  const page = await ok("read_page", { max_chars: 5000 });
  assert.match(page.text, /Second page/);

  await ok("evaluate", {
    code: "(()=>{const i=document.createElement('input');i.type='file';i.id='file';document.body.appendChild(i);return true})()",
  });
  const uploadPath = path.join(tmp, "upload.txt");
  await fsp.writeFile(uploadPath, "hello upload\n");
  const uploaded = await ok("upload", { selector: "#file", files: [uploadPath] });
  assert.equal(uploaded.fileCount, 1);
  const uploadedName = await ok("evaluate", { code: "document.getElementById('file').files[0].name" });
  assert.equal(uploadedName.value, "upload.txt");

  await ok("evaluate", {
    code: "(()=>{const b=document.createElement('button');b.id='alert';b.textContent='Alert';b.onclick=()=>alert('hi');document.body.appendChild(b);return true})()",
  });
  const blocked = await command("click", { selector: "#alert" });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error.message, /dialog/i);
  await ok("dialog", { action: "accept" });

  const closed = await ok("close_session", {});
  assert.ok(closed.closed >= 1);
  const remaining = await ok("list_tabs", {});
  assert.equal(remaining.tabs.length, 0);

  const status = await fetch(`${BASE}/status`).then((r) => r.json());
  assert.equal(status.extension_connected, true);
});
