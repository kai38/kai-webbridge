import { isPlainObject } from "./util.js";

export class BridgeError extends Error {
  constructor(code, message, { status = 200, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "BridgeError";
    this.code = code;
    this.status = status;
  }
}

export function badRequest(message) {
  return new BridgeError("bad_request", message, { status: 400 });
}

const ACTION_RE = /^[a-z][a-z0-9_]{0,63}$/;
const SESSION_MAX = 80;

export function normalizeCommand(body) {
  if (!isPlainObject(body)) throw badRequest("body must be a JSON object");
  const action = body.action ?? body.tool;
  if (typeof action !== "string" || !ACTION_RE.test(action)) {
    throw badRequest(
      'action must be a tool name such as "navigate" or "snapshot" (lowercase letters, digits, underscore)',
    );
  }
  const rawArgs = body.args === undefined ? {} : body.args;
  if (!isPlainObject(rawArgs)) throw badRequest("args must be a JSON object");
  // Internal routing fields are injected by the daemon. Never accept them from
  // an agent, otherwise it could target arbitrary tabs.
  const args = Object.fromEntries(Object.entries(rawArgs).filter(([key]) => !key.startsWith("_")));
  let session = body.session === undefined || body.session === null ? "default" : String(body.session).trim();
  if (!session) session = "default";
  if (session.length > SESSION_MAX || /[\u0000-\u001f\u007f]/.test(session)) {
    throw badRequest(`session must be 1-${SESSION_MAX} printable characters`);
  }
  let timeoutMs;
  if (body.timeout_ms !== undefined) {
    timeoutMs = Number(body.timeout_ms);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) {
      throw badRequest("timeout_ms must be an integer between 1000 and 300000");
    }
  }
  return { action, args, session, timeoutMs };
}

export function okPayload(data) {
  return { ok: true, data: data === undefined ? null : data };
}

export function errorPayload(error) {
  const code = error?.code || "internal_error";
  const message = error?.message || String(error);
  return { ok: false, error: { code, message } };
}
