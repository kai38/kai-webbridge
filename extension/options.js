const stateEl = document.getElementById("state");
const dotEl = document.getElementById("dot");
const statusEl = document.getElementById("status");
const serverUrlEl = document.getElementById("serverUrl");
const tokenEl = document.getElementById("token");
const autoConnectEl = document.getElementById("autoConnect");
const sidePanelDefaultEl = document.getElementById("sidePanelDefault");
const savedEl = document.getElementById("saved");

function render(status) {
  const connected = status?.state === "connected";
  stateEl.textContent = connected
    ? `connected to daemon${status.daemonVersion ? ` v${status.daemonVersion}` : ""}`
    : status?.state ?? "disconnected";
  dotEl.className = `dot ${connected ? "ok" : status?.state === "error" ? "bad" : ""}`;
  const lines = [
    `state: ${status?.state ?? "unknown"}`,
    `server: ${status?.serverUrl ?? "—"}`,
    `extension: v${status?.extensionVersion ?? "?"}`,
    status?.browser?.name
      ? `browser: ${status.browser.name}${status.browser.version ? ` ${status.browser.version}` : ""} (${status.browser.platform ?? "?"})`
      : null,
    status?.connectedAt ? `connected at: ${status.connectedAt}` : null,
    status?.lastError ? `error: ${status.lastError}` : null,
  ].filter(Boolean);
  statusEl.textContent = lines.join("\n");
}

async function send(message) {
  return chrome.runtime.sendMessage(message);
}

async function refresh() {
  try {
    const response = await send({ type: "kai-status" });
    if (!response?.ok) throw new Error(response?.error ?? "no response");
    const { status, settings } = response;
    render(status);
    if (document.activeElement !== serverUrlEl) serverUrlEl.value = settings.serverUrl ?? "";
    if (document.activeElement !== tokenEl) tokenEl.value = settings.token ?? "";
    autoConnectEl.checked = settings.autoConnect !== false;
    sidePanelDefaultEl.checked = settings.sidePanelDefault !== false;
  } catch (error) {
    stateEl.textContent = "service worker unavailable";
    dotEl.className = "dot bad";
    statusEl.textContent = String(error?.message ?? error);
  }
}

document.getElementById("save").addEventListener("click", async () => {
  savedEl.textContent = "saving…";
  const response = await send({
    type: "kai-save",
    settings: {
      serverUrl: serverUrlEl.value.trim(),
      token: tokenEl.value,
      autoConnect: autoConnectEl.checked,
    },
  });
  savedEl.textContent = response?.ok ? "saved" : `failed: ${response?.error ?? "unknown error"}`;
  if (response?.ok) render(response.status);
});

sidePanelDefaultEl.addEventListener("change", async () => {
  const response = await send({ type: "kai-sidepanel", enabled: sidePanelDefaultEl.checked });
  savedEl.textContent = response?.ok ? "side panel setting saved" : `failed: ${response?.error ?? "unknown error"}`;
});

document.getElementById("openPanel").addEventListener("click", async () => {
  try {
    const opening = chrome.sidePanel.open({});
    await opening;
  } catch (error) {
    savedEl.textContent = `could not open side panel: ${String(error?.message ?? error)}`;
  }
});

document.getElementById("reconnect").addEventListener("click", async () => {
  const response = await send({ type: "kai-reconnect" });
  if (response?.ok) render(response.status);
});

refresh();
setInterval(refresh, 2000);
