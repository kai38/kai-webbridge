import { EventEmitter } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { BridgeError } from "./protocol.js";
import { browserLabel, mergeBrowser, parseUserAgent } from "./browser.js";
import { PROTOCOL_VERSION } from "./version.js";

const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 30000;
const HEARTBEAT_DEAD_MS = 90000;
const HELLO_TIMEOUT_MS = 5000;

function toText(raw) {
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  return String(raw);
}

/**
 * One extension slot. The daemon accepts a single browser connection at a time
 * and answers every other browser with WebSocket close code 4409.
 */
export class Hub extends EventEmitter {
  constructor({ version, extensionWaitMs, commandTimeoutMs, logger, port = 10087 }) {
    super();
    this.version = version;
    this.extensionWaitMs = extensionWaitMs;
    this.commandTimeoutMs = commandTimeoutMs;
    this.logger = logger;
    this.port = port;
    this.client = null;
    this.pending = new Map();
    this.waiters = new Set();
    this.requestSeq = 0;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  }

  handleUpgrade(req, socket, head) {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.attach(ws, req));
  }

  attach(ws, req) {
    if (this.client && this.client.ws.readyState === WebSocket.OPEN) {
      const holder = browserLabel(this.client.browser);
      this.logger?.warn(`refusing a second extension connection; ${holder} already holds the slot`);
      ws.close(4409, `another browser is already connected (${holder})`.slice(0, 120));
      return;
    }
    if (this.client) {
      this.client.ws.terminate();
      this.#dropClient(this.client, "replaced");
    }

    const client = {
      ws,
      id: `ext-${Date.now().toString(36)}`,
      url: req?.url ?? "",
      ready: false,
      extensionVersion: null,
      extensionId: null,
      browser: parseUserAgent(req?.headers?.["user-agent"]),
      connectedAt: Date.now(),
      lastPong: Date.now(),
      heartbeat: null,
      helloTimer: null,
    };
    this.client = client;
    this.logger?.info(`extension socket opened ${client.url}`);

    ws.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(toText(raw));
      } catch (error) {
        this.logger?.warn(`invalid extension message: ${error.message}`);
        return;
      }
      this.#onMessage(client, message);
    });
    ws.on("pong", () => {
      client.lastPong = Date.now();
    });
    ws.on("close", (code, reason) => {
      this.#dropClient(client, `closed ${code} ${reason?.toString?.() ?? ""}`.trim());
    });
    ws.on("error", (error) => {
      this.logger?.warn(`extension socket error: ${error.message}`);
    });

    client.helloTimer = setTimeout(() => {
      if (!client.ready) client.ws.close(4408, "hello timeout");
    }, HELLO_TIMEOUT_MS);

    client.heartbeat = setInterval(() => {
      if (client.ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - client.lastPong > HEARTBEAT_DEAD_MS) {
        this.logger?.warn("extension stopped answering heartbeats");
        client.ws.terminate();
        return;
      }
      this.#send(client, { type: "ping" });
      try {
        client.ws.ping();
      } catch {
        /* socket is going away */
      }
    }, HEARTBEAT_INTERVAL_MS);
    client.heartbeat.unref?.();
  }

  #onMessage(client, message) {
    if (!message || typeof message !== "object") return;
    switch (message.type) {
      case "hello": {
        const hello = message.payload ?? {};
        if (hello.protocol !== PROTOCOL_VERSION || hello.client !== "kai-webbridge") {
          this.logger?.warn(
            `rejecting foreign extension on this port (client=${hello.client ?? "unknown"} version=${hello.extensionVersion ?? "?"})`,
          );
          client.ws.close(4400, "not a kai-webbridge extension");
          return;
        }
        client.ready = true;
        client.extensionVersion = String(hello.extensionVersion ?? "unknown");
        client.browser = mergeBrowser(client.browser, hello.browser);
        client.extensionId =
          typeof hello.extensionId === "string" && /^[a-p]{32}$/.test(hello.extensionId)
            ? hello.extensionId
            : null;
        client.lastPong = Date.now();
        clearTimeout(client.helloTimer);
        this.logger?.info(`extension hello v${client.extensionVersion} from ${browserLabel(client.browser)}`);
        this.#send(client, {
          type: "hello_ack",
          payload: { daemonVersion: this.version, protocol: PROTOCOL_VERSION },
        });
        for (const waiter of this.waiters) waiter.resolve(client);
        this.waiters.clear();
        this.emit("ready", client);
        break;
      }
      case "tool_result": {
        const requestId = message.requestId;
        const entry = this.pending.get(requestId);
        if (!entry) return;
        this.pending.delete(requestId);
        clearTimeout(entry.timer);
        const payload = message.payload ?? {};
        if (payload.error) {
          entry.reject(new BridgeError("extension_error", String(payload.error)));
        } else {
          entry.resolve(payload.data ?? null);
        }
        break;
      }
      case "event": {
        this.emit("extension-event", message);
        break;
      }
      case "ping":
        this.#send(client, { type: "pong" });
        client.lastPong = Date.now();
        break;
      case "pong":
        client.lastPong = Date.now();
        break;
      default:
        this.logger?.debug(`unknown extension message type: ${message.type}`);
    }
  }

  #send(client, message) {
    if (!client || client.ws.readyState !== WebSocket.OPEN) return false;
    client.ws.send(JSON.stringify(message));
    return true;
  }

  #dropClient(client, reason) {
    if (this.client !== client) return;
    this.client = null;
    clearInterval(client.heartbeat);
    clearTimeout(client.helloTimer);
    for (const waiter of this.waiters) {
      waiter.reject(
        new BridgeError("extension_not_connected", "the browser extension disconnected while the request was waiting"),
      );
    }
    this.waiters.clear();
    for (const [requestId, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new BridgeError("extension_disconnected", "the browser extension disconnected mid-request"));
      this.pending.delete(requestId);
    }
    this.logger?.info(`extension socket closed (${reason})`);
    this.emit("disconnected");
  }

  async waitForReady(timeoutMs = this.extensionWaitMs) {
    if (this.client?.ready && this.client.ws.readyState === WebSocket.OPEN) return this.client;
    if (timeoutMs <= 0) throw this.#notConnected();
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (client) => {
          clearTimeout(waiter.timer);
          this.waiters.delete(waiter);
          resolve(client);
        },
        reject: (error) => {
          clearTimeout(waiter.timer);
          this.waiters.delete(waiter);
          reject(error);
        },
        timer: null,
      };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(this.#notConnected());
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  #notConnected() {
    return new BridgeError(
      "extension_not_connected",
      "No browser extension is connected. Load the Kai WebBridge extension in Chrome and check that its options page points at this daemon (ws://127.0.0.1:" +
        `${this.port ?? 10087}/ws).`,
    );
  }

  async call(name, args, { timeoutMs = this.commandTimeoutMs } = {}) {
    const client = await this.waitForReady();
    const requestId = `req-${++this.requestSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new BridgeError(
            "timeout",
            `${name} timed out after ${timeoutMs} ms. The tab may be busy, closed, or waiting on a JavaScript dialog.`,
          ),
        );
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(requestId, { resolve, reject, timer, name });
      const sent = this.#send(client, {
        type: "tool_call",
        requestId,
        payload: { name, args },
      });
      if (!sent) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new BridgeError("extension_disconnected", "the browser extension disconnected before the command was sent"));
      }
    });
  }

  describe() {
    const client = this.client;
    return {
      connected: Boolean(client?.ready && client.ws.readyState === WebSocket.OPEN),
      extension_version: client?.extensionVersion ?? null,
      extension_id: client?.extensionId ?? null,
      browser: client?.browser ?? null,
      connected_at: client ? new Date(client.connectedAt).toISOString() : null,
    };
  }

  close() {
    if (this.client) {
      try {
        this.client.ws.close(1001, "daemon shutting down");
      } catch {
        /* ignore */
      }
    }
    this.wss.close();
  }
}
