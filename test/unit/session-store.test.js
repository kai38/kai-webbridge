import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { SessionPersistence } from "../../src/session-store.js";
import { SessionStore } from "../../src/sessions.js";
import { Daemon } from "../../src/daemon.js";
import { loadConfig } from "../../src/config.js";
import { createLogger, sleep, waitFor } from "../../src/util.js";

const silent = createLogger("silent");

async function tempDir(t, prefix = "kwb-session-") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function makeSession(overrides = {}) {
  return {
    name: "demo",
    owned: [7],
    current: 7,
    borrowed: false,
    createdAt: 1700000000000,
    updatedAt: 1700000000500,
    ...overrides,
  };
}

function captureLogger() {
  const lines = [];
  const stream = {
    write(chunk) {
      lines.push(String(chunk));
      return true;
    },
  };
  return { logger: createLogger("warn", stream), lines };
}

async function startTestDaemon(t, sessionFile) {
  if (!process.env.KAI_WEBRIDGE_HOME) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "kwb-session-home-"));
    process.env.KAI_WEBRIDGE_HOME = home;
    t.after(() => fs.rm(home, { recursive: true, force: true }));
  }
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "kwb-session-out-"));
  t.after(() => fs.rm(outputDir, { recursive: true, force: true }));
  const config = loadConfig({
    host: "127.0.0.1",
    port: 0,
    commandTimeoutMs: 1500,
    extensionWaitMs: 1000,
    outputDir,
    token: null,
    logLevel: "silent",
  });
  const daemon = new Daemon(config, { logger: silent, sessionFile });
  await daemon.start();
  let stopped = false;
  t.after(async () => {
    if (!stopped) await daemon.stop();
  });
  return {
    daemon,
    base: `http://127.0.0.1:${daemon.port}`,
    stop: async () => {
      stopped = true;
      await daemon.stop();
    },
  };
}

test("session records round-trip through the persistence file", async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, "nested", "sessions.json");

  const store = new SessionStore();
  store.observe("alpha", "navigate", { tabId: 7 });
  store.observe("alpha", "find_tab", { tabId: 9, borrowed: true });
  store.observe("beta", "navigate", { tabId: 3 });
  const snapshot = store.toJSON();
  assert.deepEqual(snapshot[0].owned, [7], "toJSON emits plain arrays, not Sets");
  assert.equal(snapshot[0].current, 9);
  assert.equal(snapshot[0].borrowed, true);

  const writer = new SessionPersistence(file);
  writer.save(snapshot);
  assert.equal(await writer.flush(), true);
  const createdDir = await fs.stat(path.dirname(file));
  assert.equal(createdDir.isDirectory(), true, "missing parent directory is created by the write");

  const document = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(document.version, 1);
  assert.match(document.saved_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(document.sessions, snapshot);

  const loaded = await new SessionPersistence(file).load();
  assert.deepEqual(loaded, snapshot);

  const restored = new SessionStore();
  assert.equal(restored.restore(loaded), 2);
  const alpha = restored.get("alpha");
  assert.equal(alpha.current, 9);
  assert.equal(alpha.borrowed, true);
  assert.deepEqual([...alpha.owned], [7]);
  assert.equal(alpha.createdAt, store.get("alpha").createdAt);
  assert.equal(alpha.updatedAt, store.get("alpha").updatedAt);
  assert.equal(restored.get("beta").current, 3);
  assert.equal(restored.restore(loaded), 0, "restoring twice does not overwrite live sessions");
});

test("corrupt or unsupported session files warn and load no sessions", async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, "sessions.json");
  await fs.writeFile(file, "{ definitely not json");

  const { logger, lines } = captureLogger();
  assert.deepEqual(await new SessionPersistence(file, { logger }).load(), []);
  assert.match(lines.join(""), /corrupt session file/);

  await fs.writeFile(file, JSON.stringify({ version: 99, sessions: [makeSession()] }));
  lines.length = 0;
  assert.deepEqual(await new SessionPersistence(file, { logger }).load(), []);
  assert.match(lines.join(""), /unsupported version/);

  await fs.writeFile(file, JSON.stringify({ version: 1, sessions: "nope" }));
  lines.length = 0;
  assert.deepEqual(await new SessionPersistence(file, { logger }).load(), []);
  assert.match(lines.join(""), /"sessions" must be an array/);
});

test("missing session file warns and is treated as empty", async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, "nested", "sessions.json");
  const { logger, lines } = captureLogger();
  assert.deepEqual(await new SessionPersistence(file, { logger }).load(), []);
  assert.match(lines.join(""), /no session file/);
});

test("invalid session entries are ignored on load", async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, "sessions.json");
  const valid = makeSession({ name: "valid", owned: [1, 2], current: 2 });
  const invalid = [
    null,
    { ...makeSession(), name: "" },
    { ...makeSession(), name: 42 },
    { ...makeSession(), name: "x".repeat(81) },
    { ...makeSession(), owned: "nope" },
    { ...makeSession(), owned: [1, "2"] },
    { ...makeSession(), owned: [0] },
    { ...makeSession(), current: "7" },
    { ...makeSession(), borrowed: "yes" },
    { ...makeSession(), createdAt: "yesterday" },
    { ...makeSession(), updatedAt: null },
    { ...makeSession(), updatedAt: 9e15 },
  ];
  await fs.writeFile(
    file,
    JSON.stringify({ version: 1, saved_at: new Date().toISOString(), sessions: [valid, ...invalid] }),
  );

  const { logger, lines } = captureLogger();
  const loaded = await new SessionPersistence(file, { logger }).load();
  assert.equal(loaded.length, 1);
  assert.deepEqual(loaded[0], valid);
  assert.match(lines.join(""), new RegExp(`ignored ${invalid.length} invalid session entries`));
});

test("writes atomically, keeping the old file when rename fails", async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, "sessions.json");
  const persistence = new SessionPersistence(file);
  persistence.save([makeSession({ name: "old", owned: [1], current: 1 })]);
  assert.equal(await persistence.flush(), true);
  const before = await fs.readFile(file, "utf8");

  const rename = fs.rename;
  let tempPath = null;
  fs.rename = async (from) => {
    tempPath = from;
    throw new Error("simulated rename failure");
  };
  try {
    persistence.save([makeSession({ name: "new", owned: [2], current: 2 })]);
    assert.equal(await persistence.flush(), false);
  } finally {
    fs.rename = rename;
  }

  assert.equal(await fs.readFile(file, "utf8"), before, "target file is untouched");
  assert.ok(tempPath, "a temp file was attempted");
  assert.notEqual(tempPath, file);
  await assert.rejects(fs.access(tempPath), "temp file is cleaned up after a failure");
  assert.deepEqual(await fs.readdir(dir), ["sessions.json"], "no temp files are left behind");

  persistence.save([makeSession({ name: "new", owned: [2], current: 2 })]);
  assert.equal(await persistence.flush(), true, "persistence recovers after a failed write");
  const document = JSON.parse(await fs.readFile(file, "utf8"));
  assert.deepEqual(document.sessions.map((entry) => entry.name), ["new"]);
});

test("saves are debounced and flush forces a write", async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, "sessions.json");
  const persistence = new SessionPersistence(file, { debounceMs: 60 });

  const writeFile = fs.writeFile;
  let writes = 0;
  fs.writeFile = async (...args) => {
    writes += 1;
    return writeFile(...args);
  };
  try {
    persistence.save([makeSession({ name: "a" })]);
    persistence.save([makeSession({ name: "b" })]);
    persistence.save([makeSession({ name: "c" })]);
    assert.equal(writes, 0, "nothing is written inside the debounce window");

    assert.equal(await persistence.flush(), true);
    assert.equal(writes, 1, "three queued snapshots coalesce into one write");
    const document = JSON.parse(await fs.readFile(file, "utf8"));
    assert.deepEqual(document.sessions.map((entry) => entry.name), ["c"], "latest snapshot wins");

    await sleep(120);
    assert.equal(writes, 1, "flushing cancels the pending debounce timer");
  } finally {
    fs.writeFile = writeFile;
  }

  const autoFile = path.join(dir, "auto.json");
  const auto = new SessionPersistence(autoFile, { debounceMs: 20 });
  auto.save([makeSession({ name: "auto" })]);
  await sleep(80);
  const autoDocument = JSON.parse(await fs.readFile(autoFile, "utf8"));
  assert.deepEqual(autoDocument.sessions.map((entry) => entry.name), ["auto"]);
});

test("daemon restores sessions before listening and persists changes on stop", async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, "sessions.json");
  const createdAt = 1700000000000;
  const updatedAt = createdAt + 25;
  const seeded = {
    name: "resumed",
    owned: [11, 12],
    current: 12,
    borrowed: false,
    createdAt,
    updatedAt,
  };
  const seed = new SessionPersistence(file);
  seed.save([seeded]);
  await seed.flush();

  const { daemon, base, stop } = await startTestDaemon(t, file);
  const resumed = daemon.sessions.get("resumed");
  assert.ok(resumed, "session loaded before start() resolves");
  assert.equal(resumed.current, 12);
  assert.equal(resumed.borrowed, false);
  assert.deepEqual([...resumed.owned], [11, 12]);
  assert.equal(resumed.createdAt, createdAt);
  assert.equal(resumed.updatedAt, updatedAt);

  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws?client=session-test`);
  await once(ws, "open");
  ws.send(
    JSON.stringify({
      type: "hello",
      payload: { extensionVersion: "test", protocol: 1, client: "kai-webbridge" },
    }),
  );
  const [ackRaw] = await once(ws, "message");
  assert.equal(JSON.parse(ackRaw.toString()).type, "hello_ack");
  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type !== "tool_call") return;
    ws.send(
      JSON.stringify({
        type: "tool_result",
        requestId: message.requestId,
        payload: { data: { success: true, tabId: 33, url: "https://example.com" } },
      }),
    );
  });

  const response = await fetch(`${base}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "navigate", args: { url: "https://example.com" }, session: "fresh" }),
  }).then((r) => r.json());
  assert.equal(response.ok, true);
  ws.close();
  await stop();

  const document = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(document.version, 1);
  const fresh = document.sessions.find((entry) => entry.name === "fresh");
  assert.ok(fresh, "new session state was flushed on stop");
  assert.deepEqual(fresh.owned, [33]);
  assert.equal(fresh.current, 33);
  assert.equal(fresh.borrowed, false);
  assert.deepEqual(
    document.sessions.find((entry) => entry.name === "resumed"),
    seeded,
    "untouched sessions keep their timestamps",
  );

  const restarted = await startTestDaemon(t, file);
  const resumedFresh = restarted.daemon.sessions.get("fresh");
  assert.ok(resumedFresh, "a restarted daemon rehydrates the tab IDs it saved");
  assert.deepEqual([...resumedFresh.owned], [33]);
  assert.equal(resumedFresh.current, 33);
  await restarted.stop();
});

test("daemon persists sessions after tab_closed pruning", async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, "sessions.json");
  const seeded = makeSession({
    name: "resumed",
    owned: [11, 12],
    current: 12,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
  });
  const seed = new SessionPersistence(file);
  seed.save([seeded]);
  await seed.flush();

  const { daemon, base, stop } = await startTestDaemon(t, file);
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws?client=prune-test`);
  await once(ws, "open");
  ws.send(
    JSON.stringify({
      type: "hello",
      payload: { extensionVersion: "test", protocol: 1, client: "kai-webbridge" },
    }),
  );
  await once(ws, "message");
  ws.send(
    JSON.stringify({ type: "event", event: "tab_closed", payload: { tabId: 12 } }),
  );
  await waitFor(() => daemon.sessions.get("resumed").current === 11, {
    timeoutMs: 2000,
    intervalMs: 10,
  });
  assert.deepEqual([...daemon.sessions.get("resumed").owned], [11]);
  ws.close();
  await stop();

  const document = JSON.parse(await fs.readFile(file, "utf8"));
  const saved = document.sessions.find((entry) => entry.name === "resumed");
  assert.deepEqual(saved.owned, [11]);
  assert.equal(saved.current, 11);
});

test("daemon starts when the session file is corrupt", async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, "sessions.json");
  await fs.writeFile(file, "{ corrupt");
  const { daemon, base } = await startTestDaemon(t, file);
  assert.deepEqual(daemon.sessions.toJSON(), []);
  const status = await fetch(`${base}/status`).then((r) => r.json());
  assert.equal(status.running, true);
});
