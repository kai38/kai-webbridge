import { test } from "node:test";
import assert from "node:assert/strict";
import { BridgeError, errorPayload, normalizeCommand, okPayload } from "../../src/protocol.js";

test("normalizeCommand applies defaults and accepts the tool alias", () => {
  const command = normalizeCommand({ tool: "snapshot" });
  assert.equal(command.action, "snapshot");
  assert.deepEqual(command.args, {});
  assert.equal(command.session, "default");
  assert.equal(command.timeoutMs, undefined);
});

test("normalizeCommand keeps a normal session and timeout", () => {
  const command = normalizeCommand({
    action: "navigate",
    args: { url: "https://example.com" },
    session: "camping research",
    timeout_ms: 5000,
  });
  assert.equal(command.session, "camping research");
  assert.equal(command.timeoutMs, 5000);
  assert.equal(command.args.url, "https://example.com");
});

test("normalizeCommand rejects malformed bodies", () => {
  for (const body of [
    null,
    [],
    { action: "Bad Tool" },
    { action: "navigate", args: [] },
    { action: "navigate", session: "x".repeat(200) },
    { action: "navigate", timeout_ms: 10 },
  ]) {
    assert.throws(() => normalizeCommand(body), (error) => error instanceof BridgeError && error.code === "bad_request");
  }
});

test("normalizeCommand strips internal routing fields", () => {
  const command = normalizeCommand({
    action: "snapshot",
    args: { _tabId: 42, _session: "spoof", max_chars: 1000 },
  });
  assert.deepEqual(command.args, { max_chars: 1000 });
});

test("envelopes have stable shapes", () => {
  assert.deepEqual(okPayload(undefined), { ok: true, data: null });
  assert.deepEqual(okPayload({ a: 1 }), { ok: true, data: { a: 1 } });
  assert.deepEqual(errorPayload(new BridgeError("timeout", "too slow")), {
    ok: false,
    error: { code: "timeout", message: "too slow" },
  });
});
