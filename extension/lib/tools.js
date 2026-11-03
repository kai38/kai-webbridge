import { chooseBestTab, hostsMatch, isBorrowableUrl } from "./browser-tabs.js";
import * as cdp from "./cdp.js";
import { network } from "./network.js";
import { capture, getBriefRef, interactiveBrief } from "./snapshot.js";
import * as sessionTabs from "./tabs.js";
import { clamp, sleep, truncate } from "./util.js";

const BROWSER_TAB_LIMIT = 200;

const PAPER_SIZES = {
  letter: [8.5, 11],
  legal: [8.5, 14],
  a4: [8.27, 11.69],
  a3: [11.69, 16.54],
  tabloid: [11, 17],
};

async function resolveTab(args) {
  if (Number.isInteger(args._tabId)) {
    const tab = await chrome.tabs.get(args._tabId).catch(() => null);
    if (tab) return tab;
  }
  throw new Error(
    "no current tab for this session. Call list_tabs to resume one of its tabs, or find_tab/navigate to select a page.",
  );
}

function sessionOf(args) {
  return typeof args._session === "string" && args._session ? args._session : "default";
}

async function captureFullPage(tabId) {
  const base = { format: "png", fromSurface: true };
  try {
    const shot = await cdp.send(tabId, "Page.captureScreenshot", { ...base, captureBeyondViewport: true }, { timeoutMs: 30000 });
    if (!shot?.data) throw new Error("no image data");
    return { format: "png", mimeType: "image/png", data: shot.data, full_page: true };
  } catch (error) {
    const shot = await cdp.send(tabId, "Page.captureScreenshot", { ...base, captureBeyondViewport: false }, { timeoutMs: 30000 });
    if (!shot?.data) throw error;
    return { format: "png", mimeType: "image/png", data: shot.data, full_page: false };
  }
}

async function pageBrief(tab, args = {}) {
  const page = await interactiveBrief(tab.id, {
    limit: args.brief_limit ?? 160,
    maxValue: args.brief_max_value ?? 160,
  });
  if (args.screenshot === false || args.brief_screenshot === false) return { page };
  try {
    return { page, screenshot: await captureFullPage(tab.id) };
  } catch (error) {
    return { page, brief_warning: `screenshot failed: ${String(error?.message ?? error)}` };
  }
}

async function withBrief(result, tab, args = {}) {
  if (args.brief === false) return result;
  try {
    return { ...result, ...(await pageBrief(tab, args)) };
  } catch (error) {
    return { ...result, brief_error: String(error?.message ?? error) };
  }
}

async function inspectPage(args) {
  const tab = await resolveTab(args);
  return { success: true, ...(await pageBrief(tab, args)) };
}

async function selectOption(args) {
  const target = args.target ?? args.selector;
  const value = String(args.value ?? "");
  if (!target) throw new Error("select: target is required");
  const tab = await resolveTab(args);
  const objectId = await cdp.resolveTarget(tab.id, target, "select");
  return cdp.callOnElement(
    tab.id,
    objectId,
    `const value = args[0];
     const el = this;
     el.focus();
     if (el instanceof HTMLSelectElement) {
       const option = [...el.options].find((item) => item.value === value || item.label === value || item.textContent.trim() === value);
       if (!option) throw new Error('select: option not found: ' + value);
       const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
       descriptor.set.call(el, option.value);
       el.dispatchEvent(new Event('input', { bubbles: true }));
       el.dispatchEvent(new Event('change', { bubbles: true }));
       return { success: true, mode: 'select', value: el.value };
     }
     el.click();
     await new Promise((resolve) => setTimeout(resolve, 150));
     const candidates = [...document.querySelectorAll('[role=option],[role=menuitem],[role=menuitemradio],[role=treeitem]')].filter((item) => {
       const rect = item.getBoundingClientRect();
       return rect.width > 0 && rect.height > 0;
     });
     const option = candidates.find((item) => (item.getAttribute('aria-label') || item.textContent || '').trim() === value);
     if (!option) throw new Error('select: option not found: ' + value);
     option.click();
     return { success: true, mode: 'aria', value };`,
    [value],
  );
}

async function setChecked(args) {
  const target = args.target ?? args.selector;
  const desired = args.checked === true;
  if (!target) throw new Error(`${desired ? "check" : "uncheck"}: target is required`);
  const tab = await resolveTab(args);
  const objectId = await cdp.resolveTarget(tab.id, target, desired ? "check" : "uncheck");
  return cdp.callOnElement(
    tab.id,
    objectId,
    `const desired = args[0];
     const el = this;
     const isCheckbox = el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio');
     if (isCheckbox) {
       if (el.checked !== desired) el.click();
       return { success: true, checked: el.checked };
     }
     const current = el.getAttribute('aria-checked') === 'true' || el.checked === true;
     if (current !== desired) el.click();
     return { success: true, checked: desired };`,
    [desired],
  );
}

async function pressKey(args) {
  const key = typeof args.key === "string" && args.key ? args.key : "Enter";
  const tab = await resolveTab(args);
  if (args.target) {
    const objectId = await cdp.resolveTarget(tab.id, args.target, "press_key");
    await cdp.callOnElement(tab.id, objectId, "this.focus(); return true;");
  }
  if (key.length === 1) {
    await cdp.send(tab.id, "Input.insertText", { text: key });
    return { success: true, key, mode: "text" };
  }
  const codes = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34, Space: 32 };
  const code = codes[key];
  if (!code) throw new Error(`press_key: unsupported key "${key}"`);
  const params = { key: key === "Space" ? " " : key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
  await cdp.send(tab.id, "Input.dispatchKeyEvent", { type: "keyDown", ...params });
  await cdp.send(tab.id, "Input.dispatchKeyEvent", { type: "keyUp", ...params });
  return { success: true, key };
}

async function hoverElement(args) {
  const target = args.target ?? args.selector;
  if (!target) throw new Error("hover: target is required");
  const tab = await resolveTab(args);
  const objectId = await cdp.resolveTarget(tab.id, target, "hover");
  const box = await cdp.send(tab.id, "DOM.getBoxModel", { objectId });
  const quad = box?.model?.content;
  if (!Array.isArray(quad) || quad.length < 8) throw new Error("hover: element has no layout box");
  const x = Math.round((quad[0] + quad[2] + quad[4] + quad[6]) / 4);
  const y = Math.round((quad[1] + quad[3] + quad[5] + quad[7]) / 4);
  await cdp.send(tab.id, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  return { success: true, x, y };
}

async function waitForLoad(tabId, timeoutMs = 30000) {
  const start = Date.now();
  let sawLoading = false;
  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error(`navigate: tab ${tabId} was closed`);
    if (tab.status === "loading") sawLoading = true;
    if (tab.status === "complete" && (sawLoading || Date.now() - start > 500)) return true;
    await sleep(100);
  }
  return false;
}

async function navigate(args) {
  const raw = typeof args.url === "string" ? args.url.trim() : "";
  if (!raw) throw new Error("navigate: url is required");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`navigate: invalid URL ${JSON.stringify(raw)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("navigate: only http:// and https:// URLs are supported");
  }
  const session = sessionOf(args);
  let tab = null;
  if (!args.newTab && Number.isInteger(args._tabId)) {
    tab = await chrome.tabs.get(args._tabId).catch(() => null);
  }
  if (!tab && !args.newTab) {
    const sessionOpen = await sessionTabs.getSessionTabs(session, args._ownedTabIds ?? []);
    tab = sessionOpen[0] ?? null;
  }
  let created = false;
  if (!tab) {
    tab = await chrome.tabs.create({ url: parsed.href, active: false });
    created = true;
  }
  if (args.active === true) {
    await chrome.tabs.update(tab.id, { active: true }).catch(() => undefined);
  }
  await sleep(200);

  // Chrome refuses debugger access to its own gallery pages. Opening and
  // grouping them still works through the tabs API, so do not fail the
  // navigation just because the page cannot be inspected.
  let debuggerAttached = true;
  try {
    await cdp.ensureAttached(tab.id);
  } catch (error) {
    if (!/cannot be scripted|extensions gallery/i.test(String(error?.message ?? error))) throw error;
    debuggerAttached = false;
  }
  if (debuggerAttached && !created) {
    const result = await cdp.send(tab.id, "Page.navigate", { url: parsed.href });
    if (result?.errorText) throw new Error(`navigate: ${result.errorText}`);
  }
  await sessionTabs.ensureGroup(tab.id, session, args.group_title);
  const loaded = await waitForLoad(tab.id, clamp(args.timeout_ms ?? 30000, 1000, 120000));
  const latest = await chrome.tabs.get(tab.id).catch(() => tab);
  return withBrief(
    {
      success: true,
      url: latest.url ?? parsed.href,
      title: latest.title ?? "",
      tabId: tab.id,
      ...(debuggerAttached ? {} : { debugger_attached: false }),
      ...(loaded ? {} : { timed_out: true }),
    },
    latest,
    args,
  );
}

function tabResult(tab, borrowed) {
  return {
    success: true,
    url: tab.url ?? tab.pendingUrl ?? "",
    title: tab.title ?? "",
    tabId: tab.id,
    borrowed,
  };
}

async function findTab(args) {
  const session = sessionOf(args);
  if (args.active === true) {
    const tab = await sessionTabs.activeTab();
    if (!tab) throw new Error("find_tab: no active tab in the current window");
    if (!isBorrowableUrl(tab.url)) {
      throw new Error("find_tab: the active tab is not an http:// or https:// page. Switch to a web page or use list_browser_tabs.");
    }
    return withBrief(tabResult(tab, true), tab, args);
  }
  if (args.tabId !== undefined && args.tabId !== null && !Number.isInteger(args.tabId)) {
    throw new Error("find_tab: tabId must be an integer. Call list_browser_tabs to find one.");
  }
  if (Number.isInteger(args.tabId)) {
    const tab = await chrome.tabs.get(args.tabId).catch(() => null);
    if (!tab) {
      throw new Error(`find_tab: tab ${args.tabId} does not exist. Call list_browser_tabs to list open tabs.`);
    }
    if (!isBorrowableUrl(tab.url)) {
      throw new Error(
        `find_tab: tab ${args.tabId} is not an http:// or https:// page. Call list_browser_tabs to pick a web tab.`,
      );
    }
    return withBrief(tabResult(tab, true), tab, args);
  }
  const wantedRaw = typeof args.url === "string" ? args.url.trim() : "";
  if (!wantedRaw) {
    throw new Error(
      "find_tab: url is required (or pass active:true or tabId). " +
        "To attach to an open browser tab, pass url with borrow:true, or call list_browser_tabs.",
    );
  }
  const tabs = await sessionTabs.getSessionTabs(session, args._ownedTabIds ?? []);
  const match = tabs.find((tab) => hostsMatch(tab.url, wantedRaw));
  if (match) return withBrief(tabResult(match, false), match, args);
  if (args.borrow === true) {
    const active = await sessionTabs.activeTab();
    const allTabs = await chrome.tabs.query({});
    const best = chooseBestTab(allTabs, {
      url: wantedRaw,
      activeTabId: active?.id ?? null,
      preferActive: true,
    });
    if (best) return withBrief(tabResult(best, true), best, args);
    throw new Error(
      `find_tab: no tab matching "${wantedRaw}" in this session or among open browser tabs (borrow:true). ` +
        "Call list_browser_tabs to inspect open tabs, or navigate with newTab to open it.",
    );
  }
  throw new Error(
    `find_tab: no tab matching "${wantedRaw}" in this session. ` +
      "Pass borrow:true to search all open browser tabs, or call list_browser_tabs to list them.",
  );
}

async function attachTab(args) {
  if (!Number.isInteger(args.tabId)) {
    throw new Error("attach_tab: tabId is required. Call list_browser_tabs to find one.");
  }
  const tab = await chrome.tabs.get(args.tabId).catch(() => null);
  if (!tab) {
    throw new Error(`attach_tab: tab ${args.tabId} does not exist. Call list_browser_tabs to list open tabs.`);
  }
  if (!isBorrowableUrl(tab.url)) {
    throw new Error(
      `attach_tab: tab ${args.tabId} is not an http:// or https:// page. Call list_browser_tabs to pick a web tab.`,
    );
  }
  return withBrief(tabResult(tab, true), tab, args);
}

async function listBrowserTabs() {
  const tabs = await chrome.tabs.query({});
  const items = tabs
    .filter((tab) => tab && Number.isInteger(tab.id) && isBorrowableUrl(tab.url))
    .slice(0, BROWSER_TAB_LIMIT)
    .map((tab) => ({
      tabId: tab.id,
      url: tab.url ?? tab.pendingUrl ?? "",
      title: tab.title ?? "",
      active: Boolean(tab.active),
      windowId: tab.windowId,
    }));
  return { success: true, tabs: items };
}

async function listTabs(args) {
  const session = sessionOf(args);
  const tabs = await sessionTabs.getSessionTabs(session, args._ownedTabIds ?? []);
  const items = [];
  for (const tab of tabs) {
    items.push({
      tabId: tab.id,
      url: tab.url,
      title: tab.title,
      active: Boolean(tab.active),
      groupTitle: await sessionTabs.groupTitleOf(tab),
      borrowed: false,
    });
  }
  if (Number.isInteger(args._tabId) && !items.some((item) => item.tabId === args._tabId)) {
    const current = await chrome.tabs.get(args._tabId).catch(() => null);
    if (current) {
      items.push({
        tabId: current.id,
        url: current.url ?? "",
        title: current.title ?? "",
        active: Boolean(current.active),
        groupTitle: await sessionTabs.groupTitleOf(current),
        borrowed: true,
      });
    }
  }
  if (Number.isInteger(args._tabId)) {
    const current = await chrome.tabs.get(args._tabId).catch(() => null);
    if (current) return withBrief({ success: true, tabs: items }, current, args);
  }
  return { success: true, tabs: items };
}

async function closeTab(args) {
  const tab = await resolveTab(args);
  await chrome.tabs.remove(tab.id);
  return { success: true, closed: true, tabId: tab.id };
}

async function closeSession(args) {
  const session = sessionOf(args);
  const closed = await sessionTabs.closeSessionTabs(session, args._ownedTabIds ?? []);
  return { success: true, closed };
}

async function snapshot(args) {
  const tab = await resolveTab(args);
  return capture(tab.id, args, tab);
}

async function readPage(args) {
  const tab = await resolveTab(args);
  const result = await cdp.evaluate(
    tab.id,
    "({ url: location.href, title: document.title, text: document.body ? document.body.innerText : '' })",
  );
  const value = result?.value ?? {};
  const limit = clamp(args.max_chars ?? 100000, 1000, 200000);
  return {
    url: String(value.url ?? tab.url ?? ""),
    title: String(value.title ?? tab.title ?? ""),
    text: truncate(String(value.text ?? ""), limit),
  };
}

async function evaluate(args) {
  if (typeof args.code !== "string" || !args.code.trim()) throw new Error("evaluate: code is required");
  const tab = await resolveTab(args);
  const result = await cdp.evaluate(tab.id, args.code);
  const value = typeof result.value === "string" ? truncate(result.value, 200000) : result.value;
  return { type: result.type ?? "undefined", value: value ?? null };
}

async function click(args) {
  const target = args.target ?? args.selector;
  const tab = await resolveTab(args);
  const objectId = await cdp.resolveTarget(tab.id, target, "click");
  const result = await cdp.callOnElement(
    tab.id,
    objectId,
    `this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
     this.click();
     return { success: true, tag: this.tagName, text: (this.textContent || '').slice(0, 100) };`,
  );
  return result ?? { success: true };
}

async function mouseClick(args) {
  const target = args.target ?? args.selector;
  const tab = await resolveTab(args);
  const objectId = await cdp.resolveTarget(tab.id, target, "mouse_click");
  const rect = await cdp.callOnElement(
    tab.id,
    objectId,
    `this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
     const r = this.getBoundingClientRect();
     return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, tag: this.tagName };`,
  );
  if (!rect || rect.w <= 0 || rect.h <= 0) throw new Error("mouse_click: element has no visible box");
  const point = { x: Math.round(rect.x), y: Math.round(rect.y), button: "left", clickCount: 1 };
  await cdp.send(tab.id, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await cdp.send(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", ...point });
  await cdp.send(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", ...point });
  return { success: true, tag: rect.tag, x: point.x, y: point.y };
}

async function fill(args) {
  const target = args.target ?? args.selector;
  if (args.value === undefined || args.value === null) throw new Error("fill: value is required");
  const value = String(args.value);
  const tab = await resolveTab(args);
  const objectId = await cdp.resolveTarget(tab.id, target, "fill");
  const result = await cdp.callOnElement(
    tab.id,
    objectId,
    `const value = args[0];
     const el = this;
     el.focus();
     if (el.isContentEditable) {
       const selection = window.getSelection();
       if (selection) {
         const range = document.createRange();
         range.selectNodeContents(el);
         selection.removeAllRanges();
         selection.addRange(range);
       }
       let inserted = false;
       try { inserted = document.execCommand('insertText', false, value); } catch (_) { inserted = false; }
       if (!inserted) {
         el.textContent = value;
         el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
       }
       return { success: true, tag: el.tagName, mode: 'contenteditable' };
     }
     const isTextarea = el instanceof HTMLTextAreaElement;
     const isInput = el instanceof HTMLInputElement;
     if (!isTextarea && !isInput) {
       throw new Error('fill: element is not an input, textarea, or contenteditable');
     }
     const proto = isTextarea ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
     const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
     if (!descriptor || !descriptor.set) throw new Error('fill: cannot set the value of this input');
     descriptor.set.call(el, value);
     el.dispatchEvent(new Event('input', { bubbles: true }));
     el.dispatchEvent(new Event('change', { bubbles: true }));
     return { success: true, tag: el.tagName, mode: 'value' };`,
    [value],
  );
  return result ?? { success: true };
}

async function cdpTool(args) {
  if (typeof args.method !== "string" || !args.method) throw new Error("cdp: method is required");
  if (args.method === "Target.activateTarget") {
    throw new Error(
      "cdp: Target.activateTarget is refused because it steals the user's focus. Use Page.bringToFront only as a last resort.",
    );
  }
  const tab = await resolveTab(args);
  const result = await cdp.send(tab.id, args.method, args.params ?? {}, { timeoutMs: 60000 });
  return result ?? {};
}

async function screenshot(args) {
  const tab = await resolveTab(args);
  const format = args.format === "jpeg" ? "jpeg" : "png";
  const params = { format };
  if (args.full_page === true) params.captureBeyondViewport = true;
  if (format === "jpeg") params.quality = clamp(args.quality ?? 80, 1, 100);
  const target = args.target ?? args.selector;
  if (target) {
    const objectId = await cdp.resolveTarget(tab.id, target, "screenshot");
    const box = await cdp.send(tab.id, "DOM.getBoxModel", { objectId });
    const quad = box?.model?.border;
    if (!Array.isArray(quad) || quad.length < 8) {
      throw new Error("screenshot: element has no layout box");
    }
    const xs = [quad[0], quad[2], quad[4], quad[6]];
    const ys = [quad[1], quad[3], quad[5], quad[7]];
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const width = Math.max(...xs) - x;
    const height = Math.max(...ys) - y;
    if (width <= 0 || height <= 0) throw new Error("screenshot: element has a zero-size box");
    params.clip = { x, y, width, height, scale: 1 };
  }
  const shot = await cdp.send(tab.id, "Page.captureScreenshot", params, { timeoutMs: 30000 });
  if (!shot?.data) throw new Error("screenshot: Chrome returned no image data");
  return {
    format,
    data: shot.data,
    mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
  };
}

async function saveAsPdf(args) {
  const tab = await resolveTab(args);
  const key = String(args.paper_format ?? "letter").toLowerCase();
  const [paperWidth, paperHeight] = PAPER_SIZES[key] ?? PAPER_SIZES.letter;
  const scale = clamp(args.scale ?? 1, 0.1, 2);
  const result = await cdp.send(
    tab.id,
    "Page.printToPDF",
    {
      printBackground: args.print_background !== false,
      landscape: Boolean(args.landscape),
      scale,
      paperWidth,
      paperHeight,
      preferCSSPageSize: true,
    },
    { timeoutMs: 60000 },
  );
  if (!result?.data) throw new Error("save_as_pdf: Chrome returned no PDF data");
  return { data: result.data, mimeType: "application/pdf", pageTitle: tab.title ?? "" };
}

async function upload(args) {
  const target = args.target ?? args.selector;
  const files = Array.isArray(args.files) ? args.files.filter((file) => typeof file === "string" && file) : [];
  if (files.length === 0) throw new Error("upload: files must be a non-empty array of paths");
  const tab = await resolveTab(args);
  const objectId = await cdp.resolveTarget(tab.id, target, "upload");
  await cdp.send(tab.id, "DOM.setFileInputFiles", { files, objectId });
  return { success: true, fileCount: files.length };
}

async function dialog(args) {
  const tab = await resolveTab(args);
  return cdp.handleDialog(tab.id, { action: args.action, promptText: args.prompt_text ?? args.promptText });
}

async function wait(args) {
  const tab = await resolveTab(args);
  let expression = null;
  if (typeof args.text === "string") {
    expression = `document.body && document.body.innerText.includes(${JSON.stringify(args.text)})`;
  } else if (typeof args.text_gone === "string") {
    expression = `!document.body || !document.body.innerText.includes(${JSON.stringify(args.text_gone)})`;
  } else if (typeof args.selector === "string") {
    expression = `!!document.querySelector(${JSON.stringify(args.selector)})`;
  }
  if (!expression) throw new Error("wait: provide text, text_gone, or selector");
  const timeoutMs = clamp(args.timeout_ms ?? 10000, 200, 60000);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await cdp.evaluate(tab.id, `Boolean(${expression})`);
    if (result?.value === true) return { matched: true, elapsedMs: Date.now() - start };
    await sleep(100);
  }
  throw new Error(`wait: timed out after ${timeoutMs}ms`);
}

async function scroll(args) {
  const tab = await resolveTab(args);
  const direction = args.direction === "up" ? -1 : 1;
  const amount = clamp(args.amount ?? 600, 1, 20000) * direction;
  const result = await cdp.evaluate(
    tab.id,
    `window.scrollBy({ top: ${amount}, behavior: 'instant' }); ({ x: window.scrollX, y: window.scrollY })`,
  );
  return { success: true, ...(result?.value ?? {}) };
}


const ACTION_ALIASES = new Map([
  ["1", "click"], ["c", "click"], ["click", "click"],
  ["2", "fill"], ["t", "fill"], ["type", "fill"], ["fill", "fill"],
  ["3", "select"], ["s", "select"], ["select", "select"],
  ["4", "press"], ["k", "press"], ["key", "press"], ["press", "press"],
  ["5", "hover"], ["h", "hover"], ["hover", "hover"],
  ["6", "upload"], ["u", "upload"], ["upload", "upload"],
  ["7", "check"], ["x", "check"], ["check", "check"],
  ["8", "uncheck"], ["o", "uncheck"], ["uncheck", "uncheck"],
]);

function unquote(value) {
  const text = String(value ?? "").trim();
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1).replace(/\\(["'\\nrt])/g, (_match, char) => {
      if (char === "n") return "\n";
      if (char === "r") return "\r";
      if (char === "t") return "\t";
      return char;
    });
  }
  return text;
}

function splitBatch(text) {
  const parts = [];
  let buffer = "";
  let quote = null;
  let escaped = false;
  for (const char of text) {
    if (escaped) {
      buffer += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      buffer += char;
      escaped = true;
      continue;
    }
    if (quote) {
      buffer += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      buffer += char;
      continue;
    }
    if (char === "," || char === ";") {
      if (buffer.trim()) parts.push(buffer.trim());
      buffer = "";
      continue;
    }
    buffer += char;
  }
  if (buffer.trim()) parts.push(buffer.trim());
  return parts;
}

function parseBatchCommands(input) {
  if (Array.isArray(input)) {
    return input.map((item) => {
      if (typeof item === "string") return parseBatchSegment(item);
      const action = ACTION_ALIASES.get(String(item.action ?? "").toLowerCase());
      return {
        ids: [Number(item.id ?? item.target)],
        action: action ?? "click",
        value: item.value === undefined ? "" : String(item.value),
      };
    });
  }
  if (typeof input !== "string" || !input.trim()) {
    throw new Error('batch: commands are required, e.g. !1:c,2:t:"text"!');
  }
  let text = input.trim();
  if (text.startsWith("!")) text = text.slice(1);
  if (text.endsWith("!")) text = text.slice(0, -1);
  return splitBatch(text).flatMap((part) => parseBatchSegment(part));
}

function parseBatchSegment(segment) {
  const text = String(segment ?? "").trim();
  if (!text) return [];
  const head = /^(\d+)(?:\s*-\s*(\d+))?\s*:\s*(.*)$/s.exec(text);
  if (!head) {
    const bare = /^(\d+)$/.exec(text);
    if (bare) return [{ ids: [Number(bare[1])], action: "click", value: "" }];
    const quoted = /^(\d+)\s+(.+)$/s.exec(text);
    if (quoted) return [{ ids: [Number(quoted[1])], action: "fill", value: unquote(quoted[2]) }];
    throw new Error(`batch: cannot parse "${text}"`);
  }
  const start = Number(head[1]);
  const end = head[2] ? Number(head[2]) : start;
  if (end < start || end - start > 100) throw new Error(`batch: invalid id range ${start}-${end}`);
  let rest = head[3].trim();
  let action = "click";
  let value = "";
  if (!rest) {
    action = "click";
  } else if (/^["']/.test(rest)) {
    action = "fill";
    value = unquote(rest);
  } else {
    const match = /^([a-zA-Z0-9_-]+)(?:\s*(?::|=)\s*|\s+)?(.*)$/s.exec(rest);
    if (!match) throw new Error(`batch: cannot parse "${text}"`);
    action = ACTION_ALIASES.get(match[1].toLowerCase());
    if (!action) throw new Error(`batch: unknown action "${match[1]}"`);
    value = unquote(match[2] ?? "");
  }
  if (action === "select" && !value) action = "click";
  if ((action === "fill" || action === "select") && !value) {
    throw new Error(`batch: ${action} needs a value for element ${start}`);
  }
  if ((action === "press" || action === "upload") && !value) {
    throw new Error(`batch: ${action} needs a value for element ${start}`);
  }
  const ids = [];
  for (let id = start; id <= end; id += 1) ids.push(id);
  return [{ ids, action, value }];
}

async function batchActions(args) {
  const tab = await resolveTab(args);
  const raw = args.commands ?? args.input ?? args.actions;
  const parsed = parseBatchCommands(raw).flatMap((command) =>
    (command.ids ?? []).map((id) => ({ id, action: command.action, value: command.value })),
  );
  if (parsed.length === 0) throw new Error("batch: no actions parsed");
  if (parsed.length > 100) throw new Error("batch: at most 100 actions per call");

  // Rebuild the numbered list so ids always refer to the current page.
  await interactiveBrief(tab.id, { limit: args.brief_limit ?? 160 });
  const results = [];
  for (const command of parsed) {
    const ref = getBriefRef(tab.id, command.id);
    if (!ref) {
      results.push({ id: command.id, action: command.action, ok: false, error: "unknown or stale element id" });
      break;
    }
    const target = `@${ref}`;
    try {
      let result;
      if (command.action === "click") result = await click({ target, _tabId: tab.id });
      else if (command.action === "fill") result = await fill({ target, value: command.value, _tabId: tab.id });
      else if (command.action === "select") result = await selectOption({ target, value: command.value, _tabId: tab.id });
      else if (command.action === "press") result = await pressKey({ target, key: command.value || "Enter", _tabId: tab.id });
      else if (command.action === "hover") result = await hoverElement({ target, _tabId: tab.id });
      else if (command.action === "upload") result = await upload({ target, files: [command.value], _tabId: tab.id });
      else if (command.action === "check") result = await setChecked({ target, checked: true, _tabId: tab.id });
      else if (command.action === "uncheck") result = await setChecked({ target, checked: false, _tabId: tab.id });
      results.push({ id: command.id, action: command.action, ok: true, result });
    } catch (error) {
      results.push({ id: command.id, action: command.action, ok: false, error: String(error?.message ?? error) });
      break;
    }
    await sleep(40);
  }
  let brief = {};
  try {
    brief = await pageBrief(tab, args);
  } catch (error) {
    brief = { brief_error: String(error?.message ?? error) };
  }
  return {
    success: results.every((item) => item.ok),
    executed: results,
    ...brief,
  };
}

const tools = {
  navigate,
  find_tab: findTab,
  attach_tab: attachTab,
  list_tabs: listTabs,
  list_browser_tabs: listBrowserTabs,
  close_tab: closeTab,
  close_session: closeSession,
  snapshot,
  inspect: inspectPage,
  batch: batchActions,
  select: selectOption,
  press_key: pressKey,
  check: setChecked,
  hover: hoverElement,
  read_page: readPage,
  evaluate,
  click,
  mouse_click: mouseClick,
  fill,
  cdp: cdpTool,
  screenshot,
  save_as_pdf: saveAsPdf,
  upload,
  dialog,
  wait,
  scroll,
  network: async (args) => {
    const tab = await resolveTab(args);
    return network(tab.id, args);
  },
};

export const TOOL_NAMES = Object.keys(tools);

export async function runTool(name, args = {}) {
  const handler = tools[name];
  if (!handler) {
    throw new Error(`Unknown tool: ${name}. Available: ${TOOL_NAMES.join(", ")}`);
  }
  return handler(args ?? {});
}
