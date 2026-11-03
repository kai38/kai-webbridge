import { addEventSink, send } from "./cdp.js";

const buffers = new Map();

addEventSink(({ tabId, method, params }) => {
  const buffer = buffers.get(tabId);
  if (!buffer || !buffer.active) return;
  if (method === "Network.requestWillBeSent") {
    buffer.requests.set(params.requestId, {
      requestId: params.requestId,
      url: params.request.url,
      method: params.request.method,
      headers: params.request.headers ?? {},
      postData: params.request.postData,
      hasPostData: Boolean(params.request.hasPostData),
      timestamp: params.timestamp,
      status: null,
      mimeType: null,
      completed: false,
      failed: false,
    });
  } else if (method === "Network.responseReceived") {
    const entry = buffer.requests.get(params.requestId);
    if (entry) {
      entry.status = params.response.status;
      entry.mimeType = params.response.mimeType;
    }
  } else if (method === "Network.loadingFinished") {
    const entry = buffer.requests.get(params.requestId);
    if (entry) entry.completed = true;
  } else if (method === "Network.loadingFailed") {
    const entry = buffer.requests.get(params.requestId);
    if (entry) {
      entry.failed = true;
      entry.errorText = params.errorText;
    }
  }
});

function summarize(entry) {
  return {
    requestId: entry.requestId,
    url: entry.url,
    method: entry.method,
    status: entry.status,
    mimeType: entry.mimeType,
    completed: entry.completed,
    failed: entry.failed,
  };
}

export async function network(tabId, args = {}) {
  const cmd = args.cmd ?? "list";
  if (cmd === "start") {
    buffers.set(tabId, { active: true, requests: new Map() });
    await send(tabId, "Network.enable", {}, { timeoutMs: 15000 });
    return { success: true, cmd: "start" };
  }
  if (cmd === "stop") {
    const buffer = buffers.get(tabId);
    await send(tabId, "Network.disable", {}, { timeoutMs: 15000 }).catch(() => undefined);
    if (buffer) buffer.active = false;
    return { success: true, cmd: "stop", captured: buffer?.requests.size ?? 0 };
  }
  if (cmd === "list") {
    const buffer = buffers.get(tabId);
    if (!buffer) throw new Error('network: capture is not running for this tab; call with {"cmd":"start"} first');
    const filter = typeof args.filter === "string" ? args.filter : "";
    const requests = [...buffer.requests.values()]
      .filter((entry) => !filter || entry.url.includes(filter))
      .slice(-500)
      .map(summarize);
    return { count: requests.length, requests };
  }
  if (cmd === "detail") {
    const buffer = buffers.get(tabId);
    const requestId = args.requestId;
    if (!buffer) throw new Error('network: capture is not running for this tab; call with {"cmd":"start"} first');
    if (typeof requestId !== "string" || !requestId) throw new Error("network: requestId is required for detail");
    const entry = buffer.requests.get(requestId);
    if (!entry) throw new Error(`network: no request with id ${requestId}`);
    const detail = { ...entry };
    if (entry.hasPostData) {
      try {
        detail.requestBody = (await send(tabId, "Network.getRequestPostData", { requestId })).postData;
      } catch {
        /* body may already be released */
      }
    }
    try {
      const body = await send(tabId, "Network.getResponseBody", { requestId }, { timeoutMs: 15000 });
      detail.body = body.base64Encoded ? `[base64 ${body.body.length} chars]` : body.body;
    } catch (error) {
      detail.bodyError = String(error?.message ?? error);
    }
    return detail;
  }
  throw new Error(`network: unknown cmd "${cmd}" (use start, stop, list, or detail)`);
}
