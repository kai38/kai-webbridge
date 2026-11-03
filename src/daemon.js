import { createHttpServer } from "./http.js";
import { Hub } from "./hub.js";
import { NO_TAB_RE, SessionStore } from "./sessions.js";
import { SessionPersistence } from "./session-store.js";
import { BridgeError, normalizeCommand } from "./protocol.js";
import { OutputStore } from "./outputs.js";
import { createLogger } from "./util.js";
import { PROTOCOL_VERSION, SERVICE_NAME, VERSION } from "./version.js";

export class Daemon {
  constructor(config, { logger, sessionFile = null } = {}) {
    this.config = config;
    this.logger = logger ?? createLogger(config.logLevel);
    this.version = VERSION;
    this.sessions = new SessionStore();
    this.sessionFile = typeof sessionFile === "string" && sessionFile ? sessionFile : null;
    if (sessionFile != null && this.sessionFile === null) {
      this.logger.warn("ignoring sessionFile: expected a non-empty string path");
    }
    this.persistence = this.sessionFile
      ? new SessionPersistence(this.sessionFile, { logger: this.logger })
      : null;
    this.sessionsLoaded = false;
    this.outputs = new OutputStore({ baseDir: config.outputDir, logger: this.logger });
    this.hub = new Hub({
      version: VERSION,
      extensionWaitMs: config.extensionWaitMs,
      commandTimeoutMs: config.commandTimeoutMs,
      logger: this.logger,
      port: config.port,
    });
    this.hub.on("extension-event", (message) => this.#onExtensionEvent(message));
    this.server = null;
    this.startedAt = null;
    this.port = config.port;
  }

  async start() {
    await this.#loadSessions();
    this.server = createHttpServer({ daemon: this, config: this.config, logger: this.logger });
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server?.off("error", onError);
        if (error.code === "EADDRINUSE") {
          reject(
            new Error(
              `port ${this.config.port} is already in use. Another daemon may be running, or set a different port in ~/.kai-webbridge/config.json.`,
            ),
          );
        } else {
          reject(error);
        }
      };
      this.server.once("error", onError);
      this.server.listen(this.config.port, this.config.host, () => {
        this.server.off("error", onError);
        const address = this.server.address();
        this.port = typeof address === "object" && address ? address.port : this.config.port;
        this.hub.port = this.port;
        this.startedAt = Date.now();
        this.logger.info(`listening on http://${this.config.host}:${this.port} (daemon v${VERSION})`);
        resolve();
      });
    });
    return this;
  }

  async stop() {
    this.hub.close();
    if (this.persistence) {
      try {
        await this.persistence.flush();
      } catch (error) {
        this.logger.warn(`could not flush ${this.sessionFile}: ${error.message}`);
      }
    }
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections?.();
    });
  }

  async execute(body) {
    const cmd = normalizeCommand(body);
    const session = this.sessions.ensure(cmd.session);
    if (session.borrowed && cmd.action === "close_tab" && cmd.args.force !== true) {
      throw new BridgeError(
        "tab_not_owned",
        "the current tab was borrowed from the user and is not owned by this session. " +
          "Pass force:true to close it, or leave it open.",
      );
    }
    if (session.borrowed && cmd.action === "navigate" && cmd.args.newTab !== true && cmd.args.adopt !== true) {
      throw new BridgeError(
        "tab_not_owned",
        "the current tab was borrowed from the user. Pass newTab:true to open a fresh tab, " +
          "or adopt:true to take the page over.",
      );
    }
    const args = this.sessions.enrich(cmd.session, cmd.args);
    const started = Date.now();
    let data;
    try {
      data = await this.hub.call(cmd.action, args, {
        timeoutMs: cmd.timeoutMs ?? this.config.commandTimeoutMs,
      });
    } catch (error) {
      if (error?.code === "extension_error" && NO_TAB_RE.test(error.message)) {
        this.sessions.clearCurrent(cmd.session);
        this.#saveSessions();
      }
      this.logger.info(
        `${cmd.session}/${cmd.action} failed in ${Date.now() - started}ms: ${error?.code ?? "error"} ${error?.message ?? ""}`,
      );
      throw error;
    }
    this.sessions.observe(cmd.session, cmd.action, data);
    this.#saveSessions();
    const result = await this.outputs.process(cmd.action, data, cmd.args);
    this.logger.info(`${cmd.session}/${cmd.action} ok in ${Date.now() - started}ms`);
    return result;
  }

  status() {
    const extension = this.hub.describe();
    return {
      service: SERVICE_NAME,
      running: true,
      version: this.version,
      protocol: PROTOCOL_VERSION,
      host: this.config.host,
      port: this.port,
      pid: process.pid,
      uptime_seconds: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      extension_connected: extension.connected,
      extension_version: extension.extension_version,
      extension_id: extension.extension_id,
      extension_browser: extension.browser,
      extension_connected_at: extension.connected_at,
      sessions: this.sessions.summary(),
      output_dir: this.config.outputDir,
      token_required: Boolean(this.config.token),
    };
  }

  async #loadSessions() {
    if (!this.persistence || this.sessionsLoaded) return;
    this.sessionsLoaded = true;
    let entries = [];
    try {
      entries = await this.persistence.load();
    } catch (error) {
      this.logger.warn(`could not load ${this.sessionFile}: ${error.message}`);
      return;
    }
    if (entries.length === 0) return;
    const restored = this.sessions.restore(entries);
    this.logger.info(`restored ${restored} session${restored === 1 ? "" : "s"} from ${this.sessionFile}`);
  }

  #saveSessions() {
    if (!this.persistence) return;
    try {
      this.persistence.save(this.sessions.toJSON());
    } catch (error) {
      this.logger.warn(`could not queue session save: ${error.message}`);
    }
  }

  #onExtensionEvent(message) {
    const payload = message.payload ?? {};
    if (message.event === "tab_closed" && Number.isInteger(payload.tabId)) {
      this.sessions.pruneTab(payload.tabId);
      this.#saveSessions();
      this.logger.debug(`extension reported tab ${payload.tabId} closed`);
    } else if (message.event === "log") {
      this.logger.debug(`extension: ${String(payload.message ?? "").slice(0, 500)}`);
    }
  }
}

export default Daemon;
