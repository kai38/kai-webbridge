import { getSettings } from "./settings.js";
import { detectBrowser } from "./browser.js";

const RETRY_DELAYS = [1000, 3000, 10000, 20000];
const STALE_AFTER_MS = 90000;
const PING_EVERY_MS = 45000;

/**
 * MV3 service worker WebSocket client. The daemon sends a JSON ping every 30 s;
 * that traffic also keeps the service worker alive. A chrome.alarm reconnects
 * after the worker has been suspended.
 */
export class Connection {
  constructor({ onToolCall, onStateChange }) {
    this.onToolCall = onToolCall;
    this.onStateChange = onStateChange;
    this.ws = null;
    this.state = "disconnected";
    this.settings = null;
    this.lastActivityAt = 0;
    this.attempt = 0;
    this.retryTimer = null;
    this.pingTimer = null;
    this.daemonVersion = null;
    this.lastError = null;
    this.connectedAt = null;
    this.browser = null;
    this.opening = false;
  }

  async start() {
    this.browser = await detectBrowser().catch(() => null);
    this.settings = await getSettingsSafe();
    await this.reconcile(true);
  }

  async refreshSettings(settings) {
    this.settings = settings ?? (await getSettingsSafe());
    return this.reconcile(true);
  }

  async reconcile(force = false) {
    if (!force && this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      if (this.ws.readyState === WebSocket.OPEN && Date.now() - this.lastActivityAt > STALE_AFTER_MS) {
        this.teardown("stale connection");
      } else {
        return;
      }
    }
    if (force) this.teardown("manual reconnect");
    if (this.opening) return;
    if (!this.settings) this.settings = await getSettingsSafe();
    if (!this.settings.autoConnect) {
      this.setState("disabled");
      return;
    }
    if (force) this.attempt = 0;
    this.open();
  }

  open() {
    if (this.opening) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.ws = null;
    this.opening = true;
    let url;
    try {
      url = new URL(this.settings.serverUrl);
      url.searchParams.set("client", this.settings.clientId);
      if (this.settings.token) url.searchParams.set("token", this.settings.token);
    } catch {
      this.lastError = `invalid server URL: ${this.settings.serverUrl}`;
      this.opening = false;
      this.setState("error");
      return;
    }
    this.clearRetry();
    this.setState("connecting");
    let ws;
    try {
      ws = new WebSocket(url.toString());
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      this.opening = false;
      this.setState("error");
      this.scheduleRetry();
      return;
    }
    this.ws = ws;

    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      this.opening = false;
      this.attempt = 0;
      this.lastError = null;
      this.lastActivityAt = Date.now();
      this.connectedAt = new Date().toISOString();
      this.setState("connected");
      this.send({
        type: "hello",
        payload: {
          extensionVersion: chrome.runtime.getManifest().version,
          protocol: 1,
          client: "kai-webbridge",
          extensionId: chrome.runtime.id,
          ...(this.browser ? { browser: this.browser } : {}),
        },
      });
      this.clearPing();
      this.pingTimer = setInterval(() => this.heartbeat(), PING_EVERY_MS);
    });

    ws.addEventListener("message", (event) => {
      if (this.ws !== ws) return;
      this.lastActivityAt = Date.now();
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      this.handleMessage(message);
    });

    ws.addEventListener("close", (event) => {
      if (this.ws !== ws) return;
      this.opening = false;
      this.ws = null;
      this.clearPing();
      if (event.code === 4409) {
        this.lastError = "another browser is already connected to this daemon";
        this.setState("error");
        this.scheduleRetry();
        return;
      }
      if (event.code === 4408) this.lastError = "daemon hello timeout";
      this.setState("disconnected");
      this.scheduleRetry();
    });

    ws.addEventListener("error", () => {
      this.lastError = `cannot reach ${this.settings.serverUrl}`;
    });
  }

  handleMessage(message) {
    switch (message?.type) {
      case "ping":
        this.send({ type: "pong" });
        break;
      case "pong":
        break;
      case "hello_ack":
        if (message.payload?.protocol !== 1) {
          this.lastError = "the daemon on this port is not Kai WebBridge (protocol mismatch)";
          this.setState("error");
          try {
            this.ws?.close(4400, "protocol mismatch");
          } catch {
            /* ignore */
          }
          break;
        }
        this.daemonVersion = message.payload?.daemonVersion ?? null;
        break;
      case "tool_call":
        void this.dispatchToolCall(message);
        break;
      default:
        break;
    }
  }

  async dispatchToolCall(message) {
    const requestId = message.requestId;
    const name = message.payload?.name;
    const args = message.payload?.args ?? {};
    try {
      if (typeof name !== "string" || !name) throw new Error("missing tool name");
      const data = await this.onToolCall(name, args);
      this.send({ type: "tool_result", requestId, payload: { data: data ?? null } });
    } catch (error) {
      this.send({
        type: "tool_result",
        requestId,
        payload: { error: String(error?.message ?? error) },
      });
    }
  }

  heartbeat() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - this.lastActivityAt > STALE_AFTER_MS) {
      this.teardown("heartbeat timeout");
      this.scheduleRetry();
      return;
    }
    this.send({ type: "ping" });
  }

  send(message) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  teardown(reason) {
    this.clearPing();
    this.clearRetry();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close(1000, reason);
      } catch {
        /* ignore */
      }
    }
    this.setState("disconnected");
  }

  scheduleRetry() {
    if (!this.settings?.autoConnect || this.retryTimer) return;
    const delay = RETRY_DELAYS[Math.min(this.attempt, RETRY_DELAYS.length - 1)];
    this.attempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.reconcile(false);
    }, delay);
  }

  clearRetry() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  clearPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.onStateChange?.(this.status());
  }

  status() {
    return {
      state: this.state,
      connected: this.state === "connected",
      serverUrl: this.settings?.serverUrl ?? null,
      daemonVersion: this.daemonVersion,
      extensionVersion: chrome.runtime.getManifest().version,
      browser: this.browser,
      connectedAt: this.connectedAt,
      lastError: this.lastError,
    };
  }
}

async function getSettingsSafe() {
  try {
    return await getSettings();
  } catch {
    return {
      serverUrl: "ws://127.0.0.1:10087/ws",
      token: "",
      autoConnect: true,
      clientId: crypto.randomUUID(),
    };
  }
}
