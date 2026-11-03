import http from "node:http";
import { URL } from "node:url";
import { BridgeError, errorPayload, okPayload } from "./protocol.js";
import { safeEqual } from "./util.js";

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new BridgeError("payload_too_large", `request body exceeds ${limit} bytes`, { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function bearer(req) {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  const alt = req.headers["x-kai-token"];
  return typeof alt === "string" ? alt : "";
}

export function createHttpServer({ daemon, config, logger }) {
  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    } catch {
      sendJson(res, 400, errorPayload(new BridgeError("bad_request", "invalid URL")));
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(200, { "content-length": "0" });
      res.end();
      return;
    }

    if (url.pathname === "/status") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, errorPayload(new BridgeError("method_not_allowed", "use GET")));
        return;
      }
      sendJson(res, 200, daemon.status());
      return;
    }

    if (url.pathname === "/health") {
      sendJson(res, 200, { ok: true, service: "kai-webbridge", version: daemon.version });
      return;
    }

    if (url.pathname === "/command") {
      if (req.method !== "POST") {
        sendJson(res, 405, errorPayload(new BridgeError("method_not_allowed", "use POST")));
        return;
      }
      // Anti-CSRF: browsers attach Origin to cross-origin requests, local CLI
      // tools do not. Silently ignore anything a web page could send.
      if (req.headers.origin !== undefined) {
        res.writeHead(200, { "content-length": "0" });
        res.end();
        return;
      }
      if (config.token) {
        if (!safeEqual(bearer(req), config.token)) {
          sendJson(res, 401, errorPayload(new BridgeError("unauthorized", "missing or invalid token", { status: 401 })));
          return;
        }
      }
      let body;
      try {
        body = JSON.parse(await readBody(req, config.maxBodyBytes));
      } catch (error) {
        if (error instanceof BridgeError) {
          sendJson(res, error.status, errorPayload(error));
        } else {
          sendJson(res, 400, errorPayload(new BridgeError("bad_request", `invalid JSON: ${error.message}`)));
        }
        return;
      }
      try {
        const data = await daemon.execute(body);
        sendJson(res, 200, okPayload(data));
      } catch (error) {
        const status = error?.status && error.status >= 400 ? error.status : 200;
        sendJson(res, status, errorPayload(error));
      }
      return;
    }

    sendJson(res, 404, errorPayload(new BridgeError("not_found", `no route for ${url.pathname}`)));
  });

  server.on("upgrade", (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    if (config.token && !safeEqual(url.searchParams.get("token") ?? "", config.token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    logger?.debug("upgrading extension websocket");
    daemon.hub.handleUpgrade(req, socket, head);
  });

  server.requestTimeout = Math.max(config.commandTimeoutMs + 15000, 30000);
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;

  return server;
}
