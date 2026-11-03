"use strict";

const REFRESH_INTERVAL_MS = 2000;
const RESPONSE_TIMEOUT_MS = 8000;

const STATUS_LABELS = {
  connected: "connected",
  connecting: "connecting",
  disconnected: "disconnected",
  error: "error",
  disabled: "disabled",
};

const elements = {
  dot: document.getElementById("status-dot"),
  label: document.getElementById("status-label"),
  browser: document.getElementById("browser-value"),
  daemon: document.getElementById("daemon-value"),
  extension: document.getElementById("extension-value"),
  server: document.getElementById("server-value"),
  errorRow: document.getElementById("error-row"),
  error: document.getElementById("last-error"),
  reconnect: document.getElementById("reconnect"),
  options: document.getElementById("options"),
};

let pollTimer = null;
let refreshInFlight = false;
let reconnectInFlight = false;

function hasStatusState(value) {
  return Object.prototype.hasOwnProperty.call(STATUS_LABELS, value);
}

function setState(nextState) {
  const state = hasStatusState(nextState) ? nextState : "error";
  if (elements.dot.dataset.state !== state) elements.dot.dataset.state = state;
  const label = STATUS_LABELS[state];
  if (elements.label.textContent !== label) elements.label.textContent = label;
}

function setValue(element, value) {
  const text = value === null || value === undefined || String(value).trim() === "" ? "—" : String(value);
  if (element.textContent !== text) element.textContent = text;
  if (text === "—") element.removeAttribute("title");
  else element.title = text;
}

function setError(message) {
  const text = message === null || message === undefined ? "" : String(message).trim();
  if (!text) {
    elements.errorRow.hidden = true;
    elements.error.textContent = "—";
    elements.error.removeAttribute("title");
    return;
  }
  if (elements.error.textContent !== text) elements.error.textContent = text;
  elements.error.title = text;
  elements.errorRow.hidden = false;
}

function formatVersion(value) {
  if (typeof value !== "string" || !value.trim()) return "—";
  const version = value.trim();
  return /^v/i.test(version) ? version : `v${version}`;
}

function formatBrowser(browser) {
  if (!browser || typeof browser !== "object") return "—";
  const name = typeof browser.name === "string" ? browser.name.trim() : "";
  const version = typeof browser.version === "string" ? browser.version.trim() : "";
  const platform = typeof browser.platform === "string" ? browser.platform.trim() : "";
  const label = [name, version].filter(Boolean).join(" ");
  if (!label && !platform) return "—";
  const browserLabel = label || "Unknown browser";
  return platform ? `${browserLabel} (${platform})` : browserLabel;
}

function extensionVersion() {
  try {
    return chrome.runtime.getManifest().version ?? "";
  } catch {
    return "";
  }
}

function describeError(error, fallback) {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error.message === "string" && error.message.trim()) return error.message.trim();
  if (error) {
    try {
      const text = String(error);
      if (text && text !== "[object Object]") return text;
    } catch {
      /* fall through */
    }
  }
  return fallback;
}

function renderStatus(status, settings) {
  if (!status || typeof status !== "object") {
    setState("error");
    setError("The extension returned an empty status.");
    return;
  }

  const rawState = typeof status.state === "string" ? status.state : "";
  const knownState = hasStatusState(rawState);
  setState(knownState ? rawState : "error");

  setValue(elements.browser, formatBrowser(status.browser));
  setValue(elements.daemon, formatVersion(status.daemonVersion));
  setValue(elements.extension, formatVersion(status.extensionVersion || extensionVersion()));
  setValue(elements.server, status.serverUrl || settings?.serverUrl || "—");

  if (typeof status.lastError === "string" && status.lastError.trim()) {
    setError(status.lastError);
  } else if (!knownState) {
    setError(`Unknown connection state: ${rawState || "none"}`);
  } else {
    setError("");
  }
}

function renderFailure(error, fallback) {
  setState("error");
  setError(describeError(error, fallback));
}

async function send(message) {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    throw new Error("Extension messaging is unavailable.");
  }
  const result = chrome.runtime.sendMessage(message);
  if (result && typeof result.then === "function") return result;
  return result;
}

function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

async function refresh() {
  if (refreshInFlight || reconnectInFlight) return;
  refreshInFlight = true;
  try {
    const response = await withTimeout(
      send({ type: "kai-status" }),
      RESPONSE_TIMEOUT_MS,
      "The extension service worker did not respond in time.",
    );
    if (!response) throw new Error("No response from the extension service worker.");
    if (!response.ok) throw new Error(describeError(response.error, "Status request failed."));
    renderStatus(response.status, response.settings);
  } catch (error) {
    renderFailure(error, "Status unavailable.");
  } finally {
    refreshInFlight = false;
  }
}

async function reconnect() {
  if (reconnectInFlight) return;
  reconnectInFlight = true;
  elements.reconnect.disabled = true;
  elements.reconnect.setAttribute("aria-busy", "true");
  try {
    const response = await withTimeout(
      send({ type: "kai-reconnect" }),
      RESPONSE_TIMEOUT_MS,
      "The extension service worker did not respond in time.",
    );
    if (!response) throw new Error("No response from the extension service worker.");
    if (!response.ok) throw new Error(describeError(response.error, "Reconnect failed."));
    if (!response.status) throw new Error("The extension returned an empty status.");
    renderStatus(response.status);
  } catch (error) {
    renderFailure(error, "Reconnect failed.");
  } finally {
    reconnectInFlight = false;
    elements.reconnect.disabled = false;
    elements.reconnect.removeAttribute("aria-busy");
  }
}

function openOptions() {
  try {
    const opening = chrome.runtime.openOptionsPage();
    if (opening && typeof opening.catch === "function") {
      opening.catch((error) => {
        renderFailure(error, "Could not open the options page.");
      });
    }
  } catch (error) {
    renderFailure(error, "Could not open the options page.");
  }
}

function startPolling() {
  void refresh();
  pollTimer = setInterval(() => {
    void refresh();
  }, REFRESH_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

elements.reconnect.addEventListener("click", () => {
  void reconnect();
});
elements.options.addEventListener("click", openOptions);
window.addEventListener("pagehide", stopPolling);
window.addEventListener("unload", stopPolling);

startPolling();
