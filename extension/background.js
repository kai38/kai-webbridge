import { Connection } from "./lib/connection.js";
import { forgetTab } from "./lib/cdp.js";
import { getSettings, saveSettings } from "./lib/settings.js";
import { runTool } from "./lib/tools.js";

const connection = new Connection({ onToolCall: runTool });
let booting = null;

async function configureSidePanel() {
  if (!chrome.sidePanel?.setPanelBehavior) return;
  try {
    const settings = await getSettings();
    await chrome.sidePanel.setPanelBehavior({
      openPanelOnActionClick: settings.sidePanelDefault !== false,
    });
  } catch (error) {
    console.warn("[kai-webbridge] could not configure side panel:", error);
  }
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
  void configureSidePanel();
  void boot();
  void chrome.alarms.create("kai-webbridge-reconnect", { periodInMinutes: 0.5 });
});

chrome.runtime.onStartup.addListener(() => {
  void configureSidePanel();
  void boot();
});

chrome.alarms.create("kai-webbridge-reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "kai-webbridge-reconnect") return;
  void boot().then(() => connection.reconcile(false));
});

chrome.action.onClicked.addListener(() => {
  // Only fires when the side panel behavior is disabled.
  void chrome.runtime.openOptionsPage();
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
        case "kai-sidepanel": {
          const settings = await saveSettings({ sidePanelDefault: Boolean(message.enabled) });
          await configureSidePanel();
          sendResponse({ ok: true, settings });
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

void configureSidePanel();
void boot();
