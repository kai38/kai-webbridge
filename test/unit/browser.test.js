import { test } from "node:test";
import assert from "node:assert/strict";
import { browserLabel, mergeBrowser, parseUserAgent } from "../../src/browser.js";

const CHROME_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.8010.36 Safari/537.36";
const EDGE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0";
const OPERA_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 OPR/120.0.0.0";

test("parseUserAgent identifies Chrome and headless Chrome", () => {
  const chrome = parseUserAgent(CHROME_UA);
  assert.equal(chrome.name, "Chrome");
  assert.equal(chrome.version, "153.0.8010.36");
  assert.equal(chrome.platform, "linux");
  assert.equal(chrome.engine, "chromium");
  assert.equal(chrome.headless, false);

  const headless = parseUserAgent(CHROME_UA.replace("Chrome/", "HeadlessChrome/"));
  assert.equal(headless.name, "Chrome (headless)");
  assert.equal(headless.headless, true);
});

test("parseUserAgent distinguishes Edge and Opera", () => {
  assert.equal(parseUserAgent(EDGE_UA).name, "Microsoft Edge");
  assert.equal(parseUserAgent(EDGE_UA).platform, "windows");
  assert.equal(parseUserAgent(OPERA_UA).name, "Opera");
  assert.equal(parseUserAgent(OPERA_UA).platform, "macos");
});

test("mergeBrowser lets the extension override the handshake fallback", () => {
  const fallback = parseUserAgent(CHROME_UA);
  const merged = mergeBrowser(fallback, {
    name: "Brave",
    version: "1.68.1",
    platform: "linux",
    arch: "x64",
  });
  assert.equal(merged.name, "Brave");
  assert.equal(merged.version, "1.68.1");
  assert.equal(merged.arch, "x64");
  assert.equal(browserLabel(merged), "Brave 1.68.1");
});

test("unknown and malformed values stay safe", () => {
  assert.equal(parseUserAgent("").name, "Unknown browser");
  assert.equal(browserLabel(null), "unknown browser");
  const merged = mergeBrowser(parseUserAgent(CHROME_UA), { name: 42, version: "x".repeat(200) });
  assert.equal(merged.name, "Chrome");
  assert.equal(merged.version, "153.0.8010.36");
});
