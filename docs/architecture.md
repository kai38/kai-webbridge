# Architecture

Kai WebBridge is three cooperating pieces: an agent-controlled HTTP API, a small
Node.js daemon, and a Chrome extension that owns the browser. This document explains
why they are split that way and how a command moves through them.

## Goals

- Drive the user's **real** browser, with real cookies and logins.
- Keep the integration surface so small that any agent which can run `curl` can use it.
- Keep all traffic on `127.0.0.1`; no accounts, cloud, or telemetry.
- Make agent work visible and reversible: one task is one named tab group.
- Keep the browser-control code readable enough to audit.

## Non-goals

- Headless scraping at scale, CI browser farms, or multi-tenant browser sharing.
- Bypassing bot detection or `isTrusted` checks.
- Being a security boundary between multiple agents. Sessions are names, not sandboxes.

## Topology

```
┌─────────────────────────────┐
│ Agent runtime               │
│ (anything that can POST     │  Reads skill/kai-webbridge/SKILL.md and
│ JSON)                       │  POSTs JSON to the daemon.
└──────────────┬──────────────┘
               │ HTTP 127.0.0.1:10087
┌──────────────▼──────────────┐
│ Daemon (Node.js)            │
│ src/daemon.js               │  Validates, tracks sessions, waits for the
│ src/http.js                 │  extension, writes files, enforces the Origin
│ src/hub.js                  │  guard and optional token. No DOM knowledge.
│ src/sessions.js             │
│ src/outputs.js              │
└──────────────┬──────────────┘
               │ WebSocket 127.0.0.1:10087/ws
┌──────────────▼──────────────┐
│ Chrome extension (MV3)      │
│ extension/background.js     │  Owns chrome.debugger sessions, refs, tab
│ extension/lib/cdp.js        │  groups, network buffers, and the tool
│ extension/lib/tools.js      │  implementations.
└──────────────┬──────────────┘
               │ CDP over chrome.debugger
┌──────────────▼──────────────┐
│ User's real tab             │
│ cookies, logins, DOM, JS    │
└─────────────────────────────┘
```

## Daemon

The daemon is deliberately thin. It never parses HTML and never decides what to click.

| File | Responsibility |
|---|---|
| `src/config.js` | Config file + env + CLI merge, validation, paths. |
| `src/protocol.js` | Command validation, envelopes, error types. |
| `src/sessions.js` | Session → owned tabs / current tab / borrowed state. |
| `src/session-store.js` | Atomic, debounced persistence of session state to `sessions.json`. |
| `src/hub.js` | Single-extension WebSocket hub, request correlation, heartbeats, 4409 guard. |
| `src/http.js` | `/command`, `/status`, `/health`, Origin guard, auth, WebSocket upgrade. |
| `src/outputs.js` | Decodes screenshot/PDF base64 and writes files. |
| `src/daemon.js` | Wires the pieces; executes one command end to end. |
| `src/cli.js` | `setup`, `start`, `stop`, `restart`, `serve`, `status`, `logs`, `install-skill`. |

Key decisions:

- **HTTP for agents, WebSocket for the browser.** Agents are request/response; a
  persistent socket is only needed between the daemon and the extension.
- **One extension slot.** Two browsers driving one daemon would interleave tabs and
  sessions unpredictably. The second connection gets close code `4409`.
- **Session state in the daemon, tab-group bindings in the extension.** Session state is
  persisted before listen and after changes, so a daemon restart keeps tabs. If the
  browser also restarts, tab IDs are stale and the extension's group binding plus
  `list_tabs` reconcile the session.
- **Files, not base64, for screenshots and PDFs.** The model gets a path; binary data
  stays out of the context window.
- **No logging of page content or arguments.** Logs contain session, tool, duration,
  and error codes.

## Extension

The extension is a module service worker with no build step. `background.js` starts a
`Connection`, registers alarms/listeners, and routes `tool_call` messages to
`lib/tools.js`.

| Module | Responsibility |
|---|---|
| `lib/connection.js` | WebSocket lifecycle, hello handshake, heartbeat, retry, tool dispatch. |
| `lib/cdp.js` | `chrome.debugger` attach/detach, per-tab command queue, dialog race, refs, evaluate/call helpers. |
| `lib/snapshot.js` | Accessibility tree fetch, ref assignment, ARIA/JSON renderers. |
| `lib/tabs.js` | Session tab groups, persistence, lookup, close. |
| `lib/network.js` | Per-tab `Network.*` capture buffer and body retrieval. |
| `lib/tools.js` | The 21 tool implementations. |
| `lib/browser-tabs.js` | URL matching/ranking for borrowing already-open tabs. |
| `sidepanel.html/js/css` | Persistent side panel: status, browser, versions, server, reconnect/options. |
| `options.html/js` | Server URL, token, auto-connect, live status. |

### CDP session model

- The extension detects its browser and platform at startup and includes them in the
  WebSocket `hello`. The daemon also derives a fallback from the handshake
  `User-Agent`, so `/status` identifies the browser even when the extension is older.
- One `chrome.debugger.attach(tabId, "1.3")` per tab, then `Page.enable` and `DOM.enable`.
- Commands to the same tab are serialized by a promise chain (`enqueue`).
- Every CDP command has a timeout (60 s default; screenshots 30 s; PDFs 60 s).
- If Chrome reports that the debugger detached, the command reattaches once and retries.
- `Page.javascriptDialogOpening` blocks the tab: commands are rejected with a message
  telling the caller to use the `dialog` tool. The dialog tool bypasses the queue so it
  can run while the triggering command is still pending.
- Navigation (`Page.frameNavigated`, main frame) increments the document key and clears
  refs. Refs from before the navigation fail with "expired ref".

### Snapshots and refs

`Accessibility.getFullAXTree` returns Chrome's accessibility tree. The extension:

1. Builds a node map and walks from the root (or from a scoped `ref`).
2. Assigns `@eN` refs to nodes with a `backendDOMNodeId`, keyed by
   `(documentKey, backendNodeId)` so the same DOM node keeps its ref across snapshots.
3. Renders ARIA text (`- button "Greet" [ref=e6]`) or a nested JSON tree.
4. Drops duplicate text children of links/buttons/headings, caps depth and node count,
   and enforces `max_chars`.

`click`/`fill`/`screenshot` resolve refs with `DOM.resolveNode` and verify the node's
document key. CSS selectors are supported as a fallback.

## Command lifecycle

1. Agent writes `{"action":"navigate","args":{...},"session":"task"}` to `/command`.
2. HTTP layer rejects requests with an `Origin` header, checks the optional token,
   validates JSON, and calls `Daemon.execute`.
3. Wrapper validates the command and asks `SessionStore` for internal args:
   `_session`, `_tabId`, `_ownedTabIds`.
4. `Hub.call` waits up to `extensionWaitMs` (29 s) for a connected extension, allocates
   a request ID, and sends `tool_call`.
5. The extension runs the tool and replies `tool_result`.
6. The daemon records the new current tab / owned tabs, post-processes output files,
   and sends `{"ok":true,"data":...}`.
7. Failures become `{"ok":false,"error":{"code","message"}}`; extension errors are
   `extension_error`.

## Tab groups

`navigate` calls `chrome.tabs.group`, sets the group title (default `agent:<session>`),
picks a stable color, and stores `session → groupId` in `chrome.storage.local`. A
daemon restart does not lose the group. `list_tabs` and `find_tab` consider both the
daemon-supplied owned tabs and the group's tabs, so the session remains usable.

Borrowed tabs are different: `find_tab`/`attach_tab` attach to a page the user already
has open without creating or moving a group tab. They are not owned by the session and
are not closed by `close_session`; `close_tab` needs `force:true` and `navigate` needs
`newTab:true` or `adopt:true`.

## Output files

- Screenshots: `<outputDir>/kai-webbridge-screenshots/screenshot_<timestamp>.<ext>`
- PDFs: `<outputDir>/kai-webbridge-pdfs/<sanitized page title>.pdf`

A caller-supplied `path` is honored verbatim. Limits: 50 MB screenshots, 100 MB PDFs.
Old files are not cleaned up automatically.

## Failure handling

| Failure | Behavior |
|---|---|
| No extension | Wait 29 s, then `extension_not_connected`. |
| Extension disconnects mid-request | `extension_disconnected`; pending requests rejected. |
| Tool exceeds daemon timeout | `timeout` (default 120 s). |
| Chrome debugger detaches | One automatic reattach and retry. |
| JS dialog opens | Command fails with a dialog message; `dialog` then `accept`/`dismiss`. |
| Tab closed | Extension emits `tab_closed`; daemon prunes it from sessions and persists. |
| Borrowed tab mutated | Daemon rejects implicit `close_tab`/`navigate` with `tab_not_owned`. |
| Ref stale | Clear error telling the agent to snapshot again. |

## Limitations

- Cross-origin iframes are not traversed. `read_page` does not offer frame handles yet.
- `click`/`fill` are DOM-level and can be ignored by sites that require trusted events.
  `mouse_click` and `cdp` use trusted CDP input.
- Trusted input to background tabs may need focus emulation in some Chrome versions.
- One browser per daemon; no per-agent isolation.
- HTTP/HTTPS navigation only. Chrome Web Store domains can be opened but not attached to (Chrome protects them from extensions).
- Linux is the only platform with an automated e2e run today.

## Roadmap

- Frame traversal in `snapshot`/`read_page`.
- Focus-emulation helper for trusted input to background tabs.
- `press_key` / `send_keys` tools.
- Per-session output directories and automatic cleanup.
- Windows/macOS CI for the e2e suite.
