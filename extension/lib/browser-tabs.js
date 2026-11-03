const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const HOST_PORT_RE = /^[a-z0-9.-]+:\d+(?:[/?#]|$)/i;
const BORROWABLE_PROTOCOLS = new Set(["http:", "https:"]);

function parseUrl(url) {
  if (typeof url !== "string") return null;
  let value = url.trim();
  if (!value) return null;
  if (!SCHEME_RE.test(value) || HOST_PORT_RE.test(value)) {
    value = value.startsWith("//") ? `https:${value}` : `https://${value}`;
  }
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Canonical form used for comparisons. Bare hosts get an https scheme, the
 * hostname is lowercased by URL, and the fragment is dropped.
 */
export function normalizeUrl(url) {
  const parsed = parseUrl(url);
  if (!parsed) return null;
  parsed.hash = "";
  return parsed.href;
}

/**
 * Host used for find_tab matching: lowercase, no trailing dot, no leading www.
 */
export function hostOf(url) {
  const parsed = parseUrl(url);
  if (!parsed || !parsed.hostname) return null;
  return parsed.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}

/**
 * True when hosts are equal or one is a subdomain of the other.
 */
export function hostsMatch(candidate, wanted) {
  const left = hostOf(candidate);
  const right = hostOf(wanted);
  if (!left || !right) return false;
  return left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`);
}

/**
 * Borrowing is limited to normal web pages; chrome://, file://, and friends
 * cannot be inspected by the extension.
 */
export function isBorrowableUrl(url) {
  const parsed = parseUrl(url);
  return Boolean(parsed && BORROWABLE_PROTOCOLS.has(parsed.protocol));
}

function hostRank(candidate, wanted) {
  if (!candidate || !wanted) return 0;
  if (candidate === wanted) return 2;
  if (candidate.endsWith(`.${wanted}`) || wanted.endsWith(`.${candidate}`)) return 1;
  return 0;
}

function lastAccessedOf(tab) {
  const value = Number(tab?.lastAccessed);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Picks the best tab to borrow for a wanted URL. Ranking is:
 * exact host, subdomain host, active tab (when preferActive), most recently
 * accessed. Non-http(s) and malformed tabs are ignored.
 */
export function chooseBestTab(tabs, { url = "", activeTabId = null, preferActive = true } = {}) {
  if (!Array.isArray(tabs) || tabs.length === 0) return null;
  const wantedRaw = typeof url === "string" ? url.trim() : "";
  const wantedHost = wantedRaw ? hostOf(wantedRaw) : null;
  if (wantedRaw && (!wantedHost || !isBorrowableUrl(wantedRaw))) return null;

  const candidates = [];
  for (const tab of tabs) {
    if (!tab || !Number.isInteger(tab.id)) continue;
    if (!isBorrowableUrl(tab.url)) continue;
    const rank = wantedHost ? hostRank(hostOf(tab.url), wantedHost) : 1;
    if (wantedHost && rank === 0) continue;
    const active = Number.isInteger(activeTabId) ? tab.id === activeTabId : tab.active === true;
    candidates.push({ tab, rank, active });
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (b.rank !== a.rank) return b.rank - a.rank;
    if (preferActive && a.active !== b.active) return a.active ? -1 : 1;
    return lastAccessedOf(b.tab) - lastAccessedOf(a.tab);
  });
  return candidates[0].tab;
}
