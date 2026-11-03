export const NO_TAB_RE = /no tab|no active tab|tab (?:is )?(?:gone|closed)|call list_tabs|has no tab/i;

// Keep aligned with SESSION_MAX in protocol.js. Persisted data is untrusted too.
export const MAX_SESSION_NAME = 80;
export const MAX_OWNED_TABS = 1000;

function isTabId(value) {
  return Number.isInteger(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER;
}

function isTimestamp(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 8640000000000000 // largest value Date#toISOString accepts
  );
}

/**
 * Validate and normalize one persisted session record. Returns null when the
 * record is malformed so callers can skip it without failing the whole load.
 */
export function normalizeSessionRecord(entry) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
  if (typeof entry.name !== "string") return null;
  const name = entry.name.trim();
  if (!name || name.length > MAX_SESSION_NAME) return null;
  if (!Array.isArray(entry.owned) || entry.owned.length > MAX_OWNED_TABS) return null;

  const owned = [];
  const seen = new Set();
  for (const tabId of entry.owned) {
    if (!isTabId(tabId)) return null;
    if (seen.has(tabId)) continue;
    seen.add(tabId);
    owned.push(tabId);
  }
  if (entry.current !== null && !isTabId(entry.current)) return null;
  if (typeof entry.borrowed !== "boolean") return null;
  if (!isTimestamp(entry.createdAt) || !isTimestamp(entry.updatedAt)) return null;

  return {
    name,
    owned,
    current: entry.current,
    borrowed: entry.borrowed,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

/**
 * Tracks which tabs belong to which agent task ("session"). The daemon is the
 * source of truth while it runs; the extension keeps a tab-group fallback so a
 * daemon restart does not orphan tabs that are still visibly grouped.
 */
export class SessionStore {
  constructor() {
    this.sessions = new Map();
  }

  ensure(name) {
    let session = this.sessions.get(name);
    if (!session) {
      session = {
        name,
        owned: new Set(),
        current: null,
        borrowed: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.sessions.set(name, session);
    }
    return session;
  }

  get(name) {
    return this.sessions.get(name) ?? null;
  }

  enrich(name, args) {
    const session = this.ensure(name);
    const enriched = { ...args, _session: name, _ownedTabIds: [...session.owned] };
    if (session.current != null) enriched._tabId = session.current;
    return enriched;
  }

  observe(name, action, data) {
    const session = this.ensure(name);
    session.updatedAt = Date.now();
    const tabId = typeof data?.tabId === "number" ? data.tabId : null;

    switch (action) {
      case "navigate":
        if (tabId != null) {
          session.owned.add(tabId);
          session.current = tabId;
          session.borrowed = false;
        }
        break;
      case "find_tab":
      case "attach_tab":
      case "activate_tab":
        if (tabId != null) {
          session.current = tabId;
          session.borrowed = Boolean(data?.borrowed);
          if (!session.borrowed) session.owned.add(tabId);
        }
        break;
      case "list_tabs":
        if (Array.isArray(data?.tabs)) {
          if (
            session.borrowed &&
            session.current != null &&
            !data.tabs.some((tab) => tab && tab.tabId === session.current)
          ) {
            session.current = null;
            session.borrowed = false;
          }
          session.owned = new Set(
            data.tabs
              .filter((tab) => tab && !tab.borrowed && Number.isInteger(tab.tabId))
              .map((tab) => tab.tabId),
          );
          if (session.current == null || (!session.owned.has(session.current) && !session.borrowed)) {
            session.current = session.owned.values().next().value ?? null;
            session.borrowed = false;
          }
        }
        break;
      case "close_tab":
        if (data?.closed) {
          if (session.current != null) session.owned.delete(session.current);
          session.current = session.owned.values().next().value ?? null;
          session.borrowed = false;
        }
        break;
      case "close_session":
        session.owned.clear();
        session.current = null;
        session.borrowed = false;
        break;
      default:
        break;
    }
  }

  clearCurrent(name) {
    const session = this.get(name);
    if (!session) return;
    session.current = session.owned.values().next().value ?? null;
    session.borrowed = false;
  }

  pruneTab(tabId) {
    for (const session of this.sessions.values()) {
      session.owned.delete(tabId);
      if (session.current === tabId) {
        session.current = session.owned.values().next().value ?? null;
        session.borrowed = false;
      }
    }
  }

  /** Plain JSON snapshot suitable for persistence. */
  toJSON() {
    return [...this.sessions.values()].map((session) => ({
      name: session.name,
      owned: [...session.owned],
      current: session.current,
      borrowed: session.borrowed,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    }));
  }

  /**
   * Rehydrate sessions from persisted records. Invalid records are ignored and
   * existing in-memory sessions win, so this is safe to call on a store that is
   * already in use. Returns the number of restored sessions.
   */
  restore(entries) {
    if (!Array.isArray(entries)) return 0;
    let restored = 0;
    for (const entry of entries) {
      const record = normalizeSessionRecord(entry);
      if (!record || this.sessions.has(record.name)) continue;
      this.sessions.set(record.name, {
        name: record.name,
        owned: new Set(record.owned),
        current: record.current,
        borrowed: record.borrowed,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      });
      restored += 1;
    }
    return restored;
  }

  summary() {
    return [...this.sessions.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((session) => ({
        name: session.name,
        tabs: session.owned.size,
        current_tab: session.current,
        borrowed: session.borrowed,
        updated_at: new Date(session.updatedAt).toISOString(),
      }));
  }
}
