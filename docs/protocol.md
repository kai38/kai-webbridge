# Protocol

Two protocols live side by side:

- **Agent → daemon:** HTTP+JSON on `127.0.0.1:10087` (the public contract).
- **Daemon ↔ extension:** WebSocket JSON on the same port (internal; may change).

## HTTP

### `GET /status`

Read-only, no auth required. Example:

```json
{
  "service": "kai-webbridge",
  "running": true,
  "version": "0.1.0",
  "protocol": 1,
  "host": "127.0.0.1",
  "port": 10087,
  "pid": 12345,
  "uptime_seconds": 42,
  "extension_connected": true,
  "extension_version": "0.1.0",
  "extension_connected_at": "2026-11-03T16:00:00.000Z",
  "sessions": [
    {"name": "research", "tabs": 3, "current_tab": 123456, "borrowed": false,
     "updated_at": "2026-11-03T16:01:00.000Z"}
  ],
  "output_dir": "/tmp",
  "token_required": false
}
```

### `GET /health`

`{"ok":true,"service":"kai-webbridge","version":"0.1.0"}`.

### `POST /command`

Request body:

```json
{"action": "navigate", "args": {"url": "https://example.com"}, "session": "task-1"}
```

- `action` (required): tool name; `tool` is accepted as an alias.
- `args` (optional, default `{}`): tool arguments.
- `session` (optional, default `"default"`): 1–80 printable characters. Put it at the
  top level, not inside `args`.
- `timeout_ms` (optional): 1000–300000; overrides the daemon command timeout.

Headers:

- `Content-Type: application/json`
- **No `Origin` header.** If present, the daemon returns `200` with an empty body and
  does not execute anything. Browsers always attach `Origin` to cross-origin requests;
  local tools do not. This is the CSRF defense.
- If a token is configured: `Authorization: Bearer <token>`.

Success:

```json
{"ok": true, "data": { ... }}
```

Failure:

```json
{"ok": false, "error": {"code": "extension_error", "message": "navigate: url is required"}}
```

Error codes:

| Code | Meaning |
|---|---|
| `bad_request` | Invalid JSON/body/action/session/timeout. |
| `unauthorized` | Token missing or wrong. |
| `method_not_allowed` | Wrong HTTP method. |
| `not_found` | Unknown route. |
| `payload_too_large` | Body over the configured limit (2 MB default). |
| `extension_not_connected` | No extension attached within the wait window. |
| `extension_disconnected` | Extension dropped mid-request. |
| `extension_error` | The tool failed; message is tool-specific. |
| `timeout` | The tool exceeded the command timeout. |
| `output_error` | Screenshot/PDF decoding or writing failed. |

## Tools

Single-tab tools use the session's current tab unless the daemon passes `_tabId`.
All arguments below are inside `args`.

| Action | Arguments | Result |
|---|---|---|
| `navigate` | `url`, `newTab?`, `active?`, `group_title?`, `timeout_ms?` | `{success,url,title,tabId,debugger_attached?}` |
| `find_tab` | `url`, `active?` | `{success,url,title,tabId,borrowed}` |
| `list_tabs` | — | `{success,tabs:[{tabId,url,title,active,groupTitle,borrowed}]}` |
| `close_tab` | — | `{success,closed}` |
| `close_session` | — | `{success,closed}` |
| `snapshot` | `format?` (`json`/`aria`), `max_chars?`, `interactive?`, `ref?` | `{url,title,tree_text?,tree?,ref_policy,truncated?}` |
| `read_page` | `max_chars?` | `{url,title,text}` |
| `click` | `target` or `selector` | `{success,tag,text}` |
| `mouse_click` | `target` or `selector` | `{success,tag,x,y}` |
| `fill` | `target`/`selector`, `value` | `{success,tag,mode}` (`value` or `contenteditable`) |
| `evaluate` | `code` | `{type,value}` |
| `cdp` | `method`, `params?` | Raw CDP result |
| `screenshot` | `format?`, `quality?`, `target?`/`selector?`, `path?` | `{format,path,sizeBytes,mimeType}` |
| `save_as_pdf` | `paper_format?`, `landscape?`, `scale?`, `print_background?`, `path?` | `{path,sizeBytes,mimeType,pageTitle}` |
| `network` | `cmd` (`start`/`stop`/`list`/`detail`), `filter?`, `requestId?` | `{count,requests}` / request detail |
| `upload` | `target`/`selector`, `files` | `{success,fileCount}` |
| `dialog` | `action` (`accept`/`dismiss`), `prompt_text?` | `{success,action}` |
| `wait` | `text?`, `text_gone?`, `selector?`, `timeout_ms?` | `{matched,elapsedMs}` |
| `scroll` | `direction?` (`up`/`down`), `amount?` | `{success,x,y}` |

Selectors may be:

- `@e12` — a ref from the latest `snapshot`.
- A CSS selector — `#name`, `button[type=submit]`, etc.

### Examples

Navigate and label the tab group:

```bash
curl -s -X POST http://127.0.0.1:10087/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"navigate","args":{"url":"https://example.com","newTab":true,"group_title":"Example"},"session":"demo"}'
```

Snapshot:

```bash
curl -s -X POST http://127.0.0.1:10087/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"snapshot","args":{"format":"aria"},"session":"demo"}'
```

Screenshot to an explicit path:

```bash
curl -s -X POST http://127.0.0.1:10087/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"screenshot","args":{"format":"jpeg","quality":60,"path":"/tmp/page.jpg"},"session":"demo"}'
```

Network capture:

```bash
# start before navigating
... -d '{"action":"network","args":{"cmd":"start"},"session":"demo"}'
... -d '{"action":"navigate","args":{"url":"https://example.com"},"session":"demo"}'
... -d '{"action":"network","args":{"cmd":"list","filter":"example"},"session":"demo"}'
... -d '{"action":"network","args":{"cmd":"detail","requestId":"<id>"},"session":"demo"}'
# stop releases the response bodies
... -d '{"action":"network","args":{"cmd":"stop"},"session":"demo"}'
```

## Session enrichment

Before forwarding, the daemon adds these fields to `args`:

| Field | Meaning |
|---|---|
| `_session` | Session name. |
| `_tabId` | The session's current tab, when known. |
| `_ownedTabIds` | Tabs this session created, used by close/list. |

These are internal. Agents should not send them.

## WebSocket (daemon ↔ extension)

URL: `ws://127.0.0.1:10087/ws?client=<uuid>&token=<token>`

The daemon accepts one extension at a time. A second connection is closed with code
`4409` ("another browser is already connected"). A connection that does not complete
the handshake within 5 s is closed with `4408`.

### Handshake

```json
// extension → daemon
{"type":"hello","payload":{"extensionVersion":"0.1.0","protocol":1,"client":"kai-webbridge"}}

// daemon → extension
{"type":"hello_ack","payload":{"daemonVersion":"0.1.0","protocol":1}}
```

A hello without `protocol: 1` and `client: "kai-webbridge"` is rejected with close code
`4400`. This keeps other browser extensions and other WebBridge implementations from
attaching to this daemon.

### Work

```json
{"type":"tool_call","requestId":"req-1","payload":{"name":"snapshot","args":{"_session":"demo"}}}
{"type":"tool_result","requestId":"req-1","payload":{"data":{...}}}
{"type":"tool_result","requestId":"req-1","payload":{"error":"..."}}
```

### Liveness

- Daemon sends `{"type":"ping"}` every 30 s; extension replies `{"type":"pong"}`.
- Daemon also sends WebSocket-level pings; a client that stops answering is terminated
  after 90 s.
- Extension reconnects with backoff (1 s, 3 s, 10 s, 20 s) and via a 30 s Chrome alarm.

### Events

```json
{"type":"event","event":"tab_closed","payload":{"tabId":123}}
```

Used to prune closed tabs from daemon sessions.

## Versioning

- `protocol: 1` is the internal extension protocol.
- The HTTP agent contract is versioned by the tool set and documented here.
- Daemon and extension versions are exposed in `/status`; the options page shows a
  protocol mismatch as an error instead of silently misbehaving.
