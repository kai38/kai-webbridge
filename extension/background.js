import { Connection } from "./lib/connection.js";
import { forgetTab } from "./lib/cdp.js";
import { getSettings, saveSettings } from "./lib/settings.js";
import { runTool } from "./lib/tools.js";

const connection = new Connection({ onToolCall: runTool });
let booting = null;

function configureSidePanel() {
  if (!chrome.sidePanel?.setPanelBehavior) return;
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => {
    console.warn("[kai-webbridge] could not configure side panel:", error);
  });
}

function boot() {
  if (!booting) {
    booting = connection.start().catch((error) => {
      console.error("[kai-webbridge] failed to start connection:", error);
      booting = null;
    });
  }
  return booting;
}

chrome.runtime.onInstalled.addListener(() => {
  configureSidePanel();
  void boot();
  void chrome.alarms.create("kai-webbridge-reconnect", { periodInMinutes: 0.5 });
});

chrome.runtime.onStartup.addListener(() => {
  configureSidePanel();
  void boot();
});

chrome.alarms.create("kai-webbridge-reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "kai-webbridge-reconnect") return;
  void boot().then(() => connection.reconcile(false));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  forgetTab(tabId);
  connection.send({ type: "event", event: "tab_closed", payload: { tabId } });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string" || !message.type.startsWith("kai-")) return false;
  (async () => {
    try {
      await boot();
      switch (message.type) {
        case "kai-status":
          sendResponse({
            ok: true,
            status: connection.status(),
            settings: await getSettings(),
          });
          break;
        case "kai-settings":
          sendResponse({ ok: true, settings: await getSettings() });
          break;
        case "kai-save": {
          const settings = await saveSettings(message.settings ?? {});
          await connection.refreshSettings(settings);
          sendResponse({ ok: true, settings, status: connection.status() });
          break;
        }
        case "kai-reconnect":
          await connection.refreshSettings();
          sendResponse({ ok: true, status: connection.status() });
          break;
        default:
          sendResponse({ ok: false, error: `unknown message ${message.type}` });
      }
    } catch (error) {
      sendResponse({ ok: false, error: String(error?.message ?? error) });
    }
  })();
  return true;
});

configureSidePanel();
void boot();
