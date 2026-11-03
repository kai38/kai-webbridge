import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chooseBestTab,
  hostOf,
  hostsMatch,
  isBorrowableUrl,
  normalizeUrl,
} from "../../extension/lib/browser-tabs.js";

test("normalizeUrl canonicalizes web URLs and accepts bare hosts", () => {
  assert.equal(normalizeUrl("HTTPS://Example.COM:443/Path?q=1#frag"), "https://example.com/Path?q=1");
  assert.equal(normalizeUrl("example.com/docs"), "https://example.com/docs");
  assert.equal(normalizeUrl("localhost:3000/x"), "https://localhost:3000/x");
  assert.equal(normalizeUrl("//example.com/x"), "https://example.com/x");
  assert.equal(normalizeUrl("http://example.com:8080/x"), "http://example.com:8080/x");
});

test("normalizeUrl rejects empty and malformed values", () => {
  assert.equal(normalizeUrl(""), null);
  assert.equal(normalizeUrl("   "), null);
  assert.equal(normalizeUrl(null), null);
  assert.equal(normalizeUrl(42), null);
  assert.equal(normalizeUrl("http://[bad"), null);
});

test("hostOf strips www, ports, case, and trailing dots", () => {
  assert.equal(hostOf("https://www.Example.com/path"), "example.com");
  assert.equal(hostOf("https://www.Example.com./path"), "example.com");
  assert.equal(hostOf("https://Example.com:8443/path"), "example.com");
  assert.equal(hostOf("example.com:8080/path"), "example.com");
  assert.equal(hostOf("127.0.0.1:8080"), "127.0.0.1");
  assert.equal(hostOf("about:blank"), null);
  assert.equal(hostOf("not a url"), null);
  assert.equal(hostOf(null), null);
});

test("hostsMatch accepts exact and subdomain hosts only", () => {
  assert.equal(hostsMatch("https://example.com/a", "https://example.com/b"), true);
  assert.equal(hostsMatch("https://www.example.com/a", "https://example.com/b"), true);
  assert.equal(hostsMatch("https://docs.example.com/a", "https://example.com/b"), true);
  assert.equal(hostsMatch("https://example.com/a", "https://docs.example.com/b"), true);
  assert.equal(hostsMatch("https://notexample.com/a", "https://example.com/b"), false);
  assert.equal(hostsMatch("https://example.org/a", "https://example.com/b"), false);
  assert.equal(hostsMatch("", "https://example.com"), false);
  assert.equal(hostsMatch(null, "https://example.com"), false);
});

test("isBorrowableUrl allows only http and https pages", () => {
  assert.equal(isBorrowableUrl("https://example.com"), true);
  assert.equal(isBorrowableUrl("http://example.com"), true);
  assert.equal(isBorrowableUrl("example.com"), true);
  assert.equal(isBorrowableUrl("localhost:3000"), true);
  assert.equal(isBorrowableUrl("chrome://settings"), false);
  assert.equal(isBorrowableUrl("chrome-extension://abc/page.html"), false);
  assert.equal(isBorrowableUrl("file:///tmp/page.html"), false);
  assert.equal(isBorrowableUrl("ftp://example.com"), false);
  assert.equal(isBorrowableUrl("about:blank"), false);
  assert.equal(isBorrowableUrl("javascript:alert(1)"), false);
  assert.equal(isBorrowableUrl(""), false);
  assert.equal(isBorrowableUrl(null), false);
});

function tab(id, url, { active = false, lastAccessed = 0 } = {}) {
  return { id, url, title: `tab ${id}`, active, lastAccessed };
}

test("chooseBestTab prefers an exact host over a subdomain", () => {
  const tabs = [
    tab(1, "https://shop.example.com/", { active: true, lastAccessed: 999 }),
    tab(2, "https://example.com/", { lastAccessed: 1 }),
    tab(3, "https://other.com/", { lastAccessed: 1000 }),
  ];
  assert.equal(chooseBestTab(tabs, { url: "https://example.com", activeTabId: 1 }), tabs[1]);
});

test("chooseBestTab matches subdomains in both directions", () => {
  const tabs = [tab(1, "https://docs.example.com/guide")];
  assert.equal(chooseBestTab(tabs, { url: "https://example.com" }), tabs[0]);
  assert.equal(chooseBestTab(tabs, { url: "https://docs.example.com" }), tabs[0]);
  const parent = [tab(1, "https://example.com/")];
  assert.equal(chooseBestTab(parent, { url: "https://docs.example.com" }), parent[0]);
});

test("chooseBestTab prefers the active tab within the same host rank", () => {
  const tabs = [
    tab(1, "https://old.example.com/", { active: true, lastAccessed: 10 }),
    tab(2, "https://new.example.com/", { active: false, lastAccessed: 500 }),
  ];
  assert.equal(chooseBestTab(tabs, { url: "example.com", activeTabId: 1 }), tabs[0]);
  assert.equal(chooseBestTab(tabs, { url: "example.com", activeTabId: 1, preferActive: false }), tabs[1]);
});

test("chooseBestTab falls back to tab.active and then lastAccessed", () => {
  const tabs = [
    tab(1, "https://one.example.com/", { active: false, lastAccessed: 10 }),
    tab(2, "https://two.example.com/", { active: true, lastAccessed: 5 }),
    tab(3, "https://three.example.com/", { active: false, lastAccessed: 100 }),
  ];
  assert.equal(chooseBestTab(tabs, { url: "example.com" }), tabs[1]);
  assert.equal(chooseBestTab(tabs, { url: "example.com", preferActive: false }), tabs[2]);
});

test("chooseBestTab ignores non-web, malformed, and unrelated tabs", () => {
  const tabs = [
    { id: 1, url: "chrome://settings", active: true, lastAccessed: 999 },
    { id: 2, url: "file:///tmp/page.html", active: true, lastAccessed: 999 },
    { id: 3, url: "https://example.com/", active: false, lastAccessed: 5 },
    { id: 4, url: "https://other.com/", active: true, lastAccessed: 999 },
    { id: "5", url: "https://example.com/", active: true, lastAccessed: 999 },
    { url: "https://example.com/", active: true },
    null,
  ];
  assert.equal(chooseBestTab(tabs, { url: "https://example.com", activeTabId: 1 }), tabs[2]);
});

test("chooseBestTab returns null when nothing matches", () => {
  const tabs = [tab(1, "https://example.com/")];
  assert.equal(chooseBestTab(tabs, { url: "https://unrelated.test" }), null);
  assert.equal(chooseBestTab(tabs, { url: "chrome://settings" }), null);
  assert.equal(chooseBestTab([], { url: "example.com" }), null);
  assert.equal(chooseBestTab(null, { url: "example.com" }), null);
});

test("chooseBestTab can pick a tab when no URL filter is given", () => {
  const tabs = [
    tab(1, "https://one.example.com/", { active: false, lastAccessed: 10 }),
    tab(2, "https://two.example.com/", { active: true, lastAccessed: 5 }),
    tab(3, "https://three.example.com/", { active: false, lastAccessed: 100 }),
  ];
  assert.equal(chooseBestTab(tabs, {}), tabs[1]);
  assert.equal(chooseBestTab(tabs, { preferActive: false }), tabs[2]);
});

test("chooseBestTab does not mutate the input order", () => {
  const tabs = [
    tab(1, "https://one.example.com/", { lastAccessed: 1 }),
    tab(2, "https://two.example.com/", { lastAccessed: 2 }),
  ];
  const before = tabs.map((item) => item.id);
  chooseBestTab(tabs, { url: "example.com" });
  assert.deepEqual(
    tabs.map((item) => item.id),
    before,
  );
});
