const tabs = new Map();
const eventSinks = new Set();
const DIALOG_SAFE_METHODS = new Set(["Page.handleJavaScriptDialog", "Page.enable", "Page.disable", "DOM.enable"]);

function createState(tabId) {
  return {
    tabId,
    attached: false,
    attaching: null,
    queue: Promise.resolve(),
    docKey: 0,
    nextRef: 1,
    refs: new Map(),
    backendRefs: new Map(),
    dialog: null,
  };
}

export function getState(tabId) {
  return tabs.get(tabId) ?? null;
}

export function documentKey(tabId) {
  return tabs.get(tabId)?.docKey ?? 0;
}

export function dialogState(tabId) {
  return tabs.get(tabId)?.dialog ?? null;
}

export function forgetTab(tabId) {
  tabs.delete(tabId);
}

export function addEventSink(sink) {
  eventSinks.add(sink);
  return () => eventSinks.delete(sink);
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (!Number.isInteger(tabId)) return;
  const state = tabs.get(tabId);
  if (!state) return;

  if (method === "Page.javascriptDialogOpening") {
    state.dialog = {
      type: params?.type ?? "alert",
      message: params?.message ?? "",
      defaultPrompt: params?.defaultPrompt,
      url: params?.url,
    };
  } else if (method === "Page.javascriptDialogClosed") {
    state.dialog = null;
  } else if (method === "Page.frameNavigated" && params?.frame && params.frame.parentId === undefined) {
    state.docKey += 1;
    state.nextRef = 1;
    state.refs.clear();
    state.backendRefs.clear();
    state.dialog = null;
  }

  for (const sink of eventSinks) {
    try {
      sink({ tabId, method, params, state });
    } catch {
      /* a broken listener must not break the debugger session */
    }
  }
});

chrome.debugger.onDetach.addListener((source) => {
  const tabId = source.tabId;
  if (!Number.isInteger(tabId)) return;
  const state = tabs.get(tabId);
  if (!state) return;
  state.attached = false;
  state.dialog = null;
  state.refs.clear();
  state.backendRefs.clear();
});

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function raw(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

function enqueue(tabId, fn) {
  const state = tabs.get(tabId) ?? createState(tabId);
  if (!tabs.has(tabId)) tabs.set(tabId, state);
  const result = state.queue.then(fn, fn);
  state.queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export async function ensureAttached(tabId) {
  let state = tabs.get(tabId);
  if (!state) {
    state = createState(tabId);
    tabs.set(tabId, state);
  }
  if (state.attached) return state;
  if (state.attaching) return state.attaching;

  state.attaching = (async () => {
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
    } catch (error) {
      if (!/already attached/i.test(String(error?.message))) {
        throw new Error(`cannot attach the debugger to tab ${tabId}: ${error?.message ?? error}`);
      }
    }
    state.attached = true;
    await raw(tabId, "Page.enable").catch(() => undefined);
    await raw(tabId, "DOM.enable").catch(() => undefined);
    return state;
  })().finally(() => {
    state.attaching = null;
  });

  return state.attaching;
}

function exceptionText(details) {
  return (
    details?.exception?.description ||
    details?.exception?.value ||
    details?.text ||
    "the page threw an exception while evaluating the expression"
  );
}

export async function send(
  tabId,
  method,
  params = {},
  { timeoutMs = 60000, bypassDialog = false, direct = false } = {},
) {
  const state = await ensureAttached(tabId);
  if (!bypassDialog && state.dialog && !DIALOG_SAFE_METHODS.has(method)) {
    const where = state.dialog.message ? ` ("${String(state.dialog.message).slice(0, 160)}")` : "";
    throw new Error(
      `A JavaScript ${state.dialog.type} dialog is open on this tab${where} and blocks the page. ` +
        'Call the dialog tool with action "accept" or "dismiss" first.',
    );
  }
  const run = async () => {
    try {
      return await withTimeout(raw(tabId, method, params), timeoutMs, method);
    } catch (error) {
      if (/not attached/i.test(String(error?.message))) {
        state.attached = false;
        await ensureAttached(tabId);
        return withTimeout(raw(tabId, method, params), timeoutMs, method);
      }
      throw error;
    }
  };

  if (direct) return run();

  return enqueue(tabId, async () => {
    if (DIALOG_SAFE_METHODS.has(method)) return run();
    const command = run();
    command.catch(() => undefined); // the dialog may win the race
    let unsubscribe = () => {};
    const dialogOpened = new Promise((_, reject) => {
      unsubscribe = addEventSink(({ tabId: eventTabId, method: eventMethod }) => {
        if (eventTabId !== tabId || eventMethod !== "Page.javascriptDialogOpening") return;
        unsubscribe();
        const dialog = state.dialog;
        const detail = dialog?.message ? ` ("${String(dialog.message).slice(0, 160)}")` : "";
        reject(
          new Error(
            `The page opened a JavaScript ${dialog?.type ?? "dialog"} dialog${detail}. ` +
              "The triggering action may have run. Call the dialog tool with action \"accept\" or \"dismiss\" to continue.",
          ),
        );
      });
    });
    try {
      return await Promise.race([command, dialogOpened]);
    } finally {
      unsubscribe();
    }
  });
}

export async function evaluate(
  tabId,
  expression,
  { awaitPromise = true, returnByValue = true, timeoutMs = 60000 } = {},
) {
  const result = await send(
    tabId,
    "Runtime.evaluate",
    { expression, returnByValue, awaitPromise },
    { timeoutMs },
  );
  if (result?.exceptionDetails) throw new Error(exceptionText(result.exceptionDetails));
  return result?.result ?? { type: "undefined" };
}

export async function callOn(tabId, objectId, functionDeclaration, args = [], { timeoutMs = 30000 } = {}) {
  const result = await send(
    tabId,
    "Runtime.callFunctionOn",
    {
      objectId,
      functionDeclaration,
      returnByValue: true,
      awaitPromise: true,
      arguments: args.map((value) => ({ value })),
    },
    { timeoutMs },
  );
  if (result?.exceptionDetails) throw new Error(exceptionText(result.exceptionDetails));
  return result?.result?.value;
}

export async function callOnElement(tabId, objectId, body, args = [], options = {}) {
  const declaration = `function(...args) {
    if (!this.isConnected) throw new Error("the element is no longer in the document — run snapshot again");
    ${body}
  }`;
  return callOn(tabId, objectId, declaration, args, options);
}

export async function resolveTarget(tabId, target, label = "element") {
  if (typeof target !== "string" || !target.trim()) {
    throw new Error(`${label}: selector is required (a CSS selector or an @e ref from snapshot)`);
  }
  const state = await ensureAttached(tabId);
  const selector = target.trim();

  if (selector.startsWith("@")) {
    const ref = selector.slice(1);
    const info = state.refs.get(ref);
    if (!info) throw new Error(`${label}: unknown ref "${ref}". Run snapshot to get refs.`);
    if (info.docKey !== state.docKey) {
      throw new Error(`${label}: ref "${ref}" expired after a navigation. Run snapshot again.`);
    }
    const resolved = await send(tabId, "DOM.resolveNode", { backendNodeId: info.backendNodeId });
    const objectId = resolved?.object?.objectId;
    if (!objectId) {
      throw new Error(`${label}: ref "${ref}" is no longer attached to the document. Run snapshot again.`);
    }
    return objectId;
  }

  const result = await evaluate(tabId, `document.querySelector(${JSON.stringify(selector)})`, {
    returnByValue: false,
  });
  if (!result?.objectId) {
    throw new Error(`${label}: no element matches selector ${JSON.stringify(selector)}`);
  }
  return result.objectId;
}

export function assignRef(tabId, backendNodeId) {
  const state = tabs.get(tabId);
  if (!state || !Number.isInteger(backendNodeId)) return null;
  const key = `${state.docKey}:${backendNodeId}`;
  const existing = state.backendRefs.get(key);
  if (existing) return existing;
  const ref = `e${state.nextRef++}`;
  state.refs.set(ref, { backendNodeId, docKey: state.docKey });
  state.backendRefs.set(key, ref);
  return ref;
}

export function findRefByBackendNode(tabId, backendNodeId) {
  const state = tabs.get(tabId);
  if (!state) return null;
  for (const [ref, info] of state.refs) {
    if (info.backendNodeId === backendNodeId) return ref;
  }
  return null;
}

export async function pageInfo(tabId) {
  const result = await evaluate(tabId, "({ url: location.href, title: document.title })");
  return {
    url: String(result?.value?.url ?? ""),
    title: String(result?.value?.title ?? ""),
  };
}

export async function handleDialog(tabId, { action = "accept", promptText } = {}) {
  const state = await ensureAttached(tabId);
  if (!state.dialog) throw new Error("no JavaScript dialog is open on this tab");
  const accept = action !== "dismiss";
  const params = { accept };
  if (typeof promptText === "string") params.promptText = promptText;
  await send(tabId, "Page.handleJavaScriptDialog", params, { bypassDialog: true, direct: true });
  state.dialog = null;
  return { success: true, action: accept ? "accept" : "dismiss" };
}

export async function detach(tabId) {
  const state = tabs.get(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* not attached */
  }
  if (state) {
    state.attached = false;
    state.refs.clear();
    state.backendRefs.clear();
  }
}

export function getRef(tabId, ref) {
  return tabs.get(tabId)?.refs.get(ref) ?? null;
}
