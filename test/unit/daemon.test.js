import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { Daemon } from "../../src/daemon.js";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/util.js";

const silent = createLogger("silent");

async function startDaemon(overrides = {}) {
  if (!process.env.KAI_WEBRIDGE_HOME) {
    process.env.KAI_WEBRIDGE_HOME = await fs.mkdtemp(path.join(os.tmpdir(), "kwb-test-home-"));
  }
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "kwb-daemon-"));
  const config = loadConfig({
    host: "127.0.0.1",
    port: 0,
    commandTimeoutMs: 1500,
    extensionWaitMs: 0,
    outputDir,
    token: null,
    logLevel: "silent",
    ...overrides,
  });
  const daemon = new Daemon(config, { logger: silent });
  await daemon.start();
  return { daemon, base: `http://127.0.0.1:${daemon.port}`, outputDir };
}

async function wsConnect(base) {
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws?client=test`);
  await once(ws, "open");
  return ws;
}

async function hello(ws, payload = {}) {
  ws.send(
    JSON.stringify({
      type: "hello",
      payload: { extensionVersion: "test", protocol: 1, client: "kai-webbridge", ...payload },
    }),
  );
  const [raw] = await once(ws, "message");
  return JSON.parse(raw.toString());
}

test("http status, method, origin guard, and bad json", async (t) => {
  const { daemon, base } = await startDaemon();
  t.after(() => daemon.stop());

  const status = await fetch(`${base}/status`).then((r) => r.json());
  assert.equal(status.service, "kai-webbridge");
  assert.equal(status.running, true);
  assert.equal(status.extension_connected, false);

  const command = await fetch(`${base}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "list_tabs", session: "test" }),
  }).then((r) => r.json());
  assert.equal(command.ok, false);
  assert.equal(command.error.code, "extension_not_connected");

  const wrongMethod = await fetch(`${base}/command`);
  assert.equal(wrongMethod.status, 405);

  const origin = await fetch(`${base}/command`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify({ action: "list_tabs" }),
  });
  assert.equal(origin.status, 200);
  assert.equal(await origin.text(), "");

  const badJson = await fetch(`${base}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "not json",
  });
  assert.equal(badJson.status, 400);
  assert.equal((await badJson.json()).error.code, "bad_request");
});

test("token auth protects commands but not status", async (t) => {
  const { daemon, base } = await startDaemon({ token: "sekret" });
  t.after(() => daemon.stop());

  const unauthorized = await fetch(`${base}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "list_tabs" }),
  });
  assert.equal(unauthorized.status, 401);
  assert.equal((await unauthorized.json()).error.code, "unauthorized");

  const authorized = await fetch(`${base}/command`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer sekret" },
    body: JSON.stringify({ action: "list_tabs" }),
  });
  assert.equal(authorized.status, 200);
  assert.equal((await authorized.json()).error.code, "extension_not_connected");

  assert.equal((await fetch(`${base}/status`)).status, 200);
});

test("foreign extensions are rejected with close code 4400", async (t) => {
  const { daemon, base } = await startDaemon();
  t.after(() => daemon.stop());

  const ws = await wsConnect(base);
  const closed = once(ws, "close");
  ws.send(JSON.stringify({ type: "hello", payload: { extensionVersion: "2.0.31" } }));
  const [code] = await closed;
  assert.equal(code, 4400);
});

test("second browser is rejected with close code 4409", async (t) => {
  const { daemon, base } = await startDaemon();
  t.after(() => daemon.stop());

  const first = await wsConnect(base);
  await hello(first);
  const second = new WebSocket(`${base.replace(/^http/, "ws")}/ws?client=second`);
  const closed = once(second, "close");
  await once(second, "open");
  const [code] = await closed;
  assert.equal(code, 4409);
  first.close();
});

test("commands round-trip through a fake extension and inject session state", async (t) => {
  const { daemon, base, outputDir } = await startDaemon();
  t.after(() => daemon.stop());

  const ws = await wsConnect(base);
  await hello(ws, {
    extensionId: "a".repeat(32),
    browser: { name: "Brave", version: "1.68.1", platform: "linux", arch: "x64", engine: "chromium" },
  });
  const status = await fetch(`${base}/status`).then((r) => r.json());
  assert.equal(status.extension_id, "a".repeat(32));
  assert.equal(status.extension_browser.name, "Brave");
  assert.equal(status.extension_browser.arch, "x64");
  const seen = [];
  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type !== "tool_call") return;
    seen.push(message.payload);
    const name = message.payload.name;
    let data;
    if (name === "navigate") data = { success: true, url: "https://example.com", tabId: 42 };
    else if (name === "snapshot") data = { url: "https://example.com", title: "Example", tree_text: '- button "Go" [ref=e1]' };
    else if (name === "screenshot") {
      data = {
        format: "png",
        data: Buffer.from("fake-screenshot").toString("base64"),
        mimeType: "image/png",
      };
    } else if (name === "close_session") data = { success: true, closed: 1 };
    else data = { success: true };
    ws.send(JSON.stringify({ type: "tool_result", requestId: message.requestId, payload: { data } }));
  });

  const navigate = await fetch(`${base}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "navigate", args: { url: "https://example.com" }, session: "demo" }),
  }).then((r) => r.json());
  assert.equal(navigate.ok, true);
  assert.equal(navigate.data.tabId, 42);

  const snapshot = await fetch(`${base}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "snapshot", args: {}, session: "demo" }),
  }).then((r) => r.json());
  assert.match(snapshot.data.tree_text, /button "Go"/);

  const snapshotCall = seen.find((call) => call.name === "snapshot");
  assert.equal(snapshotCall.args._session, "demo");
  assert.equal(snapshotCall.args._tabId, 42);
  assert.deepEqual(snapshotCall.args._ownedTabIds, [42]);

  const screenshot = await fetch(`${base}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "screenshot", args: {}, session: "demo" }),
  }).then((r) => r.json());
  assert.equal(screenshot.ok, true);
  assert.match(screenshot.data.path, /kai-webbridge-screenshots/);
  assert.equal(await fs.readFile(screenshot.data.path, "utf8"), "fake-screenshot");
  assert.ok(screenshot.data.path.startsWith(outputDir));

  const close = await fetch(`${base}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "close_session", args: {}, session: "demo" }),
  }).then((r) => r.json());
  assert.equal(close.data.closed, 1);
  assert.deepEqual(daemon.sessions.get("demo").owned.size, 0);
});

test("a silent extension produces a timeout error", async (t) => {
  const { daemon, base } = await startDaemon({ commandTimeoutMs: 300 });
  t.after(() => daemon.stop());

  const ws = await wsConnect(base);
  await hello(ws);
  ws.on("message", () => {
    /* swallow tool calls */
  });
  const response = await fetch(`${base}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "snapshot", args: {}, session: "slow" }),
  }).then((r) => r.json());
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "timeout");
});

test("extension errors are surfaced as extension_error", async (t) => {
  const { daemon, base } = await startDaemon();
  t.after(() => daemon.stop());

  const ws = await wsConnect(base);
  await hello(ws);
  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    ws.send(
      JSON.stringify({
        type: "tool_result",
        requestId: message.requestId,
        payload: { error: "Unknown tool: nope. Available: snapshot, navigate" },
      }),
    );
  });
  const response = await fetch(`${base}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "nope", args: {}, session: "x" }),
  }).then((r) => r.json());
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "extension_error");
  assert.match(response.error.message, /Unknown tool/);
});

test("websocket connections require the token when one is configured", async (t) => {
  const { daemon, base } = await startDaemon({ token: "sekret" });
  t.after(() => daemon.stop());
  const url = `${base.replace(/^http/, "ws")}/ws?client=test`;

  const denied = new WebSocket(url);
  const [error] = await once(denied, "error");
  assert.match(String(error.message), /401/);

  const allowed = new WebSocket(`${url}&token=sekret`);
  await once(allowed, "open");
  const ack = await hello(allowed);
  assert.equal(ack.type, "hello_ack");
  allowed.close();
});
