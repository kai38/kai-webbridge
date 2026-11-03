import fsp from "node:fs/promises";
import path from "node:path";
import { normalizeSessionRecord } from "./sessions.js";

export { normalizeSessionRecord };

export const STORE_VERSION = 1;
export const DEFAULT_DEBOUNCE_MS = 100;
export const MAX_SESSIONS = 500;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Atomic, debounced JSON persistence for session state.
 *
 * The on-disk document is `{ version, saved_at, sessions }` where each session
 * is `{ name, owned, current, borrowed, createdAt, updatedAt }`. Writes go to a
 * sibling temp file first and are renamed into place, so readers never observe
 * a partially written file. Persistence failures are logged and swallowed: a
 * broken session file must never prevent the daemon from starting or stopping.
 */
export class SessionPersistence {
  constructor(file, { logger = null, debounceMs = DEFAULT_DEBOUNCE_MS } = {}) {
    if (typeof file !== "string" || !file) {
      throw new TypeError("SessionPersistence requires a file path");
    }
    this.file = file;
    this.logger = logger;
    this.debounceMs =
      Number.isFinite(debounceMs) && debounceMs >= 0 ? debounceMs : DEFAULT_DEBOUNCE_MS;
    this.pending = null;
    this.timer = null;
    this.writing = Promise.resolve();
    this.lastWriteOk = true;
    this.tempSeq = 0;
  }

  /** Read and validate the session file. Never throws; returns [] on failure. */
  async load() {
    let raw;
    try {
      raw = await fsp.readFile(this.file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        this.logger?.warn(`no session file at ${this.file}; starting with no persisted sessions`);
      } else {
        this.logger?.warn(`could not read session file ${this.file}: ${error.message}`);
      }
      return [];
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      this.logger?.warn(`corrupt session file ${this.file}: ${error.message}`);
      return [];
    }
    if (!isPlainObject(parsed)) {
      this.logger?.warn(`corrupt session file ${this.file}: expected a JSON object`);
      return [];
    }
    if (parsed.version !== STORE_VERSION) {
      this.logger?.warn(
        `ignoring session file ${this.file}: unsupported version ${String(parsed.version)} (expected ${STORE_VERSION})`,
      );
      return [];
    }
    if (!Array.isArray(parsed.sessions)) {
      this.logger?.warn(`corrupt session file ${this.file}: "sessions" must be an array`);
      return [];
    }

    if (parsed.sessions.length > MAX_SESSIONS) {
      this.logger?.warn(
        `session file ${this.file} has more than ${MAX_SESSIONS} sessions; keeping the first ${MAX_SESSIONS}`,
      );
    }
    const sessions = [];
    const seen = new Set();
    let invalid = 0;
    for (const entry of parsed.sessions.slice(0, MAX_SESSIONS)) {
      const record = normalizeSessionRecord(entry);
      if (!record) {
        invalid += 1;
        continue;
      }
      if (seen.has(record.name)) {
        invalid += 1;
        continue;
      }
      seen.add(record.name);
      sessions.push(record);
    }
    if (invalid > 0) {
      this.logger?.warn(`ignored ${invalid} invalid session entr${invalid === 1 ? "y" : "ies"} in ${this.file}`);
    }
    return sessions;
  }

  /**
   * Queue a save of the given session records. Multiple calls inside the
   * debounce window collapse into one write of the latest snapshot.
   */
  save(entries) {
    if (!Array.isArray(entries)) {
      this.logger?.warn("ignoring session snapshot: expected an array");
      return false;
    }
    const sessions = [];
    for (const entry of entries) {
      if (sessions.length >= MAX_SESSIONS) break;
      const record = normalizeSessionRecord(entry);
      if (record) sessions.push(record);
    }
    this.pending = sessions;
    this.#schedule();
    return true;
  }

  /** Cancel the debounce and wait until every queued snapshot is on disk. */
  async flush() {
    this.#cancelTimer();
    do {
      if (this.pending !== null) {
        const sessions = this.pending;
        this.pending = null;
        this.#enqueue(sessions);
      }
      await this.writing;
    } while (this.pending !== null);
    return this.lastWriteOk;
  }

  #schedule() {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
  }

  #cancelTimer() {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  #enqueue(sessions) {
    this.writing = this.writing.then(async () => {
      try {
        await this.#write(sessions);
        this.lastWriteOk = true;
      } catch (error) {
        this.lastWriteOk = false;
        this.logger?.warn(`could not save sessions to ${this.file}: ${error.message}`);
      }
    });
  }

  async #write(sessions) {
    const directory = path.dirname(this.file);
    await fsp.mkdir(directory, { recursive: true });
    const document = {
      version: STORE_VERSION,
      saved_at: new Date().toISOString(),
      sessions,
    };
    const body = `${JSON.stringify(document, null, 2)}\n`;
    const tmp = path.join(
      directory,
      `.${path.basename(this.file)}.${process.pid}.${++this.tempSeq}.tmp`,
    );
    try {
      await fsp.writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
      await fsp.rename(tmp, this.file);
    } catch (error) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  }
}

export default SessionPersistence;
