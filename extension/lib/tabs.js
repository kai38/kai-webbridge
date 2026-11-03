const BINDINGS_KEY = "sessionGroups";
const COLORS = ["blue", "cyan", "green", "orange", "pink", "purple", "red", "yellow"];
export const TAB_GROUP_ID_NONE = -1;

function colorFor(session) {
  let hash = 0;
  for (let i = 0; i < session.length; i += 1) hash = (hash * 31 + session.charCodeAt(i)) | 0;
  return COLORS[Math.abs(hash) % COLORS.length];
}

async function loadBindings() {
  const raw = await chrome.storage.local.get(BINDINGS_KEY);
  return raw[BINDINGS_KEY] && typeof raw[BINDINGS_KEY] === "object" ? { ...raw[BINDINGS_KEY] } : {};
}

async function saveBindings(bindings) {
  await chrome.storage.local.set({ [BINDINGS_KEY]: bindings });
}

export function sessionLabel(session) {
  return `agent:${session}`;
}

export async function ensureGroup(tabId, session, title) {
  const bindings = await loadBindings();
  let groupId = bindings[session];
  if (groupId != null) {
    try {
      await chrome.tabGroups.get(groupId);
    } catch {
      groupId = null;
      delete bindings[session];
    }
  }
  const tab = await chrome.tabs.get(tabId);
  if (tab.groupId != null && tab.groupId !== TAB_GROUP_ID_NONE) groupId = tab.groupId;

  if (groupId == null) {
    groupId = await chrome.tabs.group({ tabIds: [tabId] });
  } else {
    try {
      await chrome.tabs.group({ tabIds: [tabId], groupId });
    } catch {
      groupId = await chrome.tabs.group({ tabIds: [tabId] });
    }
  }

  const label = (typeof title === "string" && title.trim()) || sessionLabel(session);
  try {
    await chrome.tabGroups.update(groupId, { title: label, color: colorFor(session), collapsed: false });
  } catch {
    /* title/color are cosmetic */
  }
  bindings[session] = groupId;
  await saveBindings(bindings);
  return groupId;
}

export async function getSessionTabs(session, ownedTabIds = []) {
  const bindings = await loadBindings();
  const ids = new Set((ownedTabIds ?? []).filter((id) => Number.isInteger(id)));
  const groupId = bindings[session];
  if (groupId != null) {
    try {
      const grouped = await chrome.tabs.query({ groupId });
      for (const tab of grouped) if (Number.isInteger(tab.id)) ids.add(tab.id);
    } catch {
      delete bindings[session];
      await saveBindings(bindings);
    }
  }
  const result = [];
  for (const id of ids) {
    try {
      result.push(await chrome.tabs.get(id));
    } catch {
      /* tab is gone */
    }
  }
  return result;
}

export async function groupTitleOf(tab) {
  if (!tab || tab.groupId == null || tab.groupId === TAB_GROUP_ID_NONE) return null;
  try {
    const group = await chrome.tabGroups.get(tab.groupId);
    return group.title ?? null;
  } catch {
    return null;
  }
}

export async function closeSessionTabs(session, ownedTabIds = []) {
  const tabs = await getSessionTabs(session, ownedTabIds);
  let closed = 0;
  for (const tab of tabs) {
    try {
      await chrome.tabs.remove(tab.id);
      closed += 1;
    } catch {
      /* already gone */
    }
  }
  const bindings = await loadBindings();
  delete bindings[session];
  await saveBindings(bindings);
  return closed;
}

export async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab ?? null;
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

export function hostsMatch(candidate, wanted) {
  if (!candidate || !wanted) return false;
  return candidate === wanted || candidate.endsWith(`.${wanted}`) || wanted.endsWith(`.${candidate}`);
}
