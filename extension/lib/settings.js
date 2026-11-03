export const DEFAULT_SERVER_URL = "ws://127.0.0.1:10087/ws";

export async function getSettings() {
  const raw = await chrome.storage.local.get(["serverUrl", "token", "autoConnect", "clientId"]);
  let clientId = raw.clientId;
  if (typeof clientId !== "string" || !clientId) {
    clientId = crypto.randomUUID();
    await chrome.storage.local.set({ clientId });
  }
  return {
    serverUrl: typeof raw.serverUrl === "string" && raw.serverUrl ? raw.serverUrl : DEFAULT_SERVER_URL,
    token: typeof raw.token === "string" ? raw.token : "",
    autoConnect: raw.autoConnect !== false,
    clientId,
  };
}

export async function saveSettings(patch) {
  const allowed = {};
  if (typeof patch.serverUrl === "string") allowed.serverUrl = patch.serverUrl.trim();
  if (typeof patch.token === "string") allowed.token = patch.token;
  if (typeof patch.autoConnect === "boolean") allowed.autoConnect = patch.autoConnect;
  await chrome.storage.local.set(allowed);
  return getSettings();
}
