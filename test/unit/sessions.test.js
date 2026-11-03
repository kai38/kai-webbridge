import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionStore } from "../../src/sessions.js";

test("enrich injects the session, current tab, and owned tabs", () => {
  const store = new SessionStore();
  store.observe("task", "navigate", { tabId: 7 });
  const args = store.enrich("task", { url: "https://example.com" });
  assert.equal(args._session, "task");
  assert.equal(args._tabId, 7);
  assert.deepEqual(args._ownedTabIds, [7]);
  assert.equal(args.url, "https://example.com");
});

test("observe tracks navigate, borrowed tabs, and list reconciliation", () => {
  const store = new SessionStore();
  store.observe("t", "navigate", { tabId: 1 });
  store.observe("t", "navigate", { tabId: 2 });
  assert.equal(store.get("t").current, 2);

  store.observe("t", "find_tab", { tabId: 99, borrowed: true });
  assert.equal(store.get("t").current, 99);
  assert.equal(store.get("t").borrowed, true);
  assert.deepEqual([...store.get("t").owned], [1, 2]);

  store.observe("t", "list_tabs", { tabs: [{ tabId: 2 }, { tabId: 3 }] });
  assert.deepEqual([...store.get("t").owned], [2, 3]);
  assert.equal(store.get("t").current, 99, "a borrowed tab stays current");
  assert.equal(store.get("t").borrowed, true);

  store.observe("t", "find_tab", { tabId: 2 });
  assert.equal(store.get("t").current, 2);
  assert.equal(store.get("t").borrowed, false);
});

test("close_tab promotes another owned tab; close_session clears", () => {
  const store = new SessionStore();
  store.observe("t", "navigate", { tabId: 1 });
  store.observe("t", "navigate", { tabId: 2 });
  store.observe("t", "close_tab", { closed: true });
  assert.equal(store.get("t").current, 1);
  assert.deepEqual([...store.get("t").owned], [1]);

  store.observe("t", "close_session", { closed: 1 });
  assert.equal(store.get("t").current, null);
  assert.equal(store.get("t").owned.size, 0);
});

test("pruneTab removes a closed tab from every session", () => {
  const store = new SessionStore();
  store.observe("a", "navigate", { tabId: 5 });
  store.observe("b", "navigate", { tabId: 5 });
  store.pruneTab(5);
  assert.equal(store.get("a").current, null);
  assert.equal(store.get("b").current, null);
});

test("summary is JSON-friendly", () => {
  const store = new SessionStore();
  store.observe("x", "navigate", { tabId: 3 });
  const [summary] = store.summary();
  assert.equal(summary.name, "x");
  assert.equal(summary.tabs, 1);
  assert.equal(summary.current_tab, 3);
  assert.match(summary.updated_at, /^\d{4}-/);
});
