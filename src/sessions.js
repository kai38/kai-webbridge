export const NO_TAB_RE = /no tab|no active tab|tab (?:is )?(?:gone|closed)|call list_tabs|has no tab/i;

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
