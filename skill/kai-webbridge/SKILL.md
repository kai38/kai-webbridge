---
name: kai-webbridge
description: |
  Kai WebBridge lets you drive the user's real Chrome browser through a local daemon — open pages, read them, click, type, screenshot, save PDFs, and inspect network traffic using the user's actual login sessions. Use this skill whenever the user asks to browse a website, open a URL, read or scrape page content, take a screenshot, fill a form, or automate anything that needs a real signed-in browser.
metadata:
  version: "0.1.0"
---

# Kai WebBridge

You control the user's real Chrome through a local daemon. No headless browser, no separate profile: the tabs are the user's tabs and the cookies are the user's cookies.

The daemon listens on `http://127.0.0.1:10087` by default. The CLI is `kai-webbridge` when installed globally, or `node bin/kai-webbridge.js` from a checkout.

## Before the first call

Check that the daemon and extension are alive:

```bash
curl -s http://127.0.0.1:10087/status
```

- `extension_connected: true` — ready. `extension_browser` names the browser holding the extension (Chrome, Edge, Brave, Opera, or Vivaldi).
- Connection refused — run `kai-webbridge start` and retry.
- `extension_connected: false` — tell the user to open the Chromium-based browser that has the extension loaded and check its options page. Do not try to install the extension for them.

## Call format

Every command is one HTTP POST. The top-level `session` names the task and is required on every call (the daemon defaults it, but do not rely on that).

```bash
curl -s -X POST http://127.0.0.1:10087/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"navigate","args":{"url":"https://example.com","newTab":true,"group_title":"Example task"},"session":"example-task"}'
```

- Success: `{"ok":true,"data":...}`
- Failure: `{"ok":false,"error":{"code":"...","message":"..."}}`
- Put `session` at the top level, **not** inside `args`.
- Never send an `Origin` header (browsers do; the daemon intentionally ignores those requests).

## Sessions and tab groups

One task = one session, with one Chrome tab group for tabs it opens.

- Pick one session name at the start and reuse it for the whole task.
- Pass `group_title` on the first `navigate` to name the group in the user's language.
- Tabs opened in the same session join the same group automatically.
- `close_session` closes the whole group. Only call it when the user asks to close the tabs.
- The daemon remembers the session's current tab; single-tab tools operate on it.
- Session state persists in `~/.kai-webbridge/sessions.json`; after a daemon restart, call `list_tabs` to resume.
- Borrowed tabs (pages the user already had open) are not grouped and are not closed by `close_session`.

## Working with pages the user already has open

When the user says "use the page I have open" or asks about an existing tab:

1. Call `list_browser_tabs` and pick the tab, or call `find_tab` with `url` and `borrow:true`.
2. The reply has `borrowed:true`; subsequent tools act on that tab.
3. Do not group, rename, navigate, or close a borrowed tab implicitly. `navigate` needs `newTab:true` or `adopt:true`; `close_tab` needs `force:true`.
4. `close_session` leaves borrowed tabs open; release them by attaching another tab or closing the session.

## Page briefs and batch actions

`navigate`, `find_tab`, `attach_tab`, and `list_tabs` return a `page` brief automatically:

```json
"page": {
  "counts": {"buttons": 10, "text_fields": 4, "links": 3},
  "interactive": [
    {"id": 1, "role": "button", "name": "Search", "ref": "@e1"},
    {"id": 2, "type": "text", "name": "Query", "ref": "@e2"}
  ]
},
"screenshot_path": "/tmp/...png"
```

Use the numbers in one `batch` call:

```json
{"action":"batch","args":{"commands":"!2:t:\"Kai WebBridge\",1:c!"},"session":"task"}
```

- `c`/`1` click, `t`/`2` type, `s`/`3` select, `k`/`4` key, `h`/`5` hover,
  `u`/`6` upload, `x`/`7` check, `o`/`8` uncheck.
- `2:"text"` means fill element 2.
- `1:3` with no value falls back to click.
- Batch returns a fresh `page` + `screenshot_path`; IDs reset after navigation.
- Use `brief:false` to skip the automatic brief/screenshot.
- If an ID is missing or stale, call `inspect` first.

## Tools

| Tool | Args | Returns | Notes |
|---|---|---|---|
| `navigate` | `url`, `newTab`, `active`, `group_title`, `brief?` | `{success,url,title,tabId,page,screenshot_path}` | First call opens the tab and creates the group. Returns numbered elements + full screenshot automatically. |
| `find_tab` | `url?`, `active?`, `borrow?`, `tabId?`, `brief?` | `{success,url,title,tabId,borrowed,page,screenshot_path}` | Session tabs first; `active:true` borrows the user's current tab; `borrow:true` searches all open tabs by host; `tabId` attaches an exact tab. Auto-brief. |
| `list_tabs` | — | `{success,tabs:[{tabId,url,title,active,groupTitle,borrowed}]}` | Tabs in this session plus the borrowed current tab. |
| `list_browser_tabs` | — | `{success,tabs:[{tabId,url,title,active,windowId}]}` | All open http(s) tabs. Read-only. |
| `attach_tab` | `tabId`, `brief?` | `{success,tabId,url,title,borrowed,page,screenshot_path}` | Attach an exact tab returned by `list_browser_tabs`; auto-brief. |
| `close_tab` | `force?` | `{success,closed,tabId}` | Closes the current tab. A borrowed tab needs `force:true`. |
| `close_session` | — | `{success,closed}` | Close the whole group. |
| `snapshot` | `format` (`json`/`aria`), `max_chars`, `interactive`, `ref` | `{url,title,tree_text}` with `[ref=eN]` | Accessibility tree. Prefer this over CSS selectors. |
| `inspect` | `brief?`, `screenshot?` | `{success,page,screenshot_path}` | Re-scrape numbered elements + full-page screenshot without acting. |
| `batch` | `commands` | `{success,executed,page,screenshot_path}` | Do several numbered actions at once. |
| `select` | `target`, `value` | `{success,mode,value}` | Native `<select>` or visible ARIA options. |
| `press_key` | `target?`, `key` | `{success,key}` | Focus target, then press Enter/Tab/Escape/etc. |
| `check` / `uncheck` | `target` | `{success,checked}` | Toggle checkbox/radio/ARIA switch. |
| `hover` | `target` | `{success,x,y}` | Move real mouse to element centre. |
| `read_page` | `max_chars` | `{url,title,text}` | Plain text of the page. |
| `click` | `target` or `selector` (`@eN` or CSS) | `{success,tag,text}` | DOM `.click()`. Sites that require trusted events may ignore it; try `mouse_click`. |
| `mouse_click` | `target` or `selector` | `{success,tag,x,y}` | Real CDP mouse events at the element center. |
| `fill` | `target`/`selector`, `value` | `{success,tag,mode}` | Replaces the value; works on inputs, textareas, and contenteditable editors. |
| `evaluate` | `code` | `{type,value}` | Runs in the page. Wrap in an IIFE for a fresh scope. |
| `cdp` | `method`, `params` | raw CDP result | Escape hatch. `Target.activateTarget` is refused. |
| `screenshot` | `format` (`png`/`jpeg`), `quality`, `selector`, `path` | `{format,path,sizeBytes,mimeType}` | Returns a **file path**, not base64. Open it with a file tool. |
| `save_as_pdf` | `paper_format`, `landscape`, `scale`, `print_background`, `path` | `{path,sizeBytes,mimeType,pageTitle}` | Returns a file path. |
| `network` | `cmd` (`start`/`stop`/`list`/`detail`), `filter`, `requestId` | requests | Capture is per tab. Call `detail` before `stop`. |
| `upload` | `target`/`selector`, `files` (string[]) | `{success,fileCount}` | Sets a file input. |
| `dialog` | `action` (`accept`/`dismiss`), `prompt_text` | `{success,action}` | Required when a JS dialog blocks the page. |
| `wait` | `text`, `text_gone`, `selector`, `timeout_ms` | `{matched,elapsedMs}` | Polls the page. |
| `scroll` | `direction` (`up`/`down`), `amount` | `{success,x,y}` | Scrolls the viewport. |

## Reading pages

`snapshot` is the primary observation tool:

```bash
curl -s -X POST http://127.0.0.1:10087/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"snapshot","args":{"format":"aria"},"session":"example-task"}'
```

The response contains lines like:

```
- heading "Example Domain" [ref=e2]
- link "More information..." [ref=e4]
```

- Use `@e4` directly as the `target` of `click`, `fill`, `screenshot`, or `upload`.
- Refs expire after navigation; take a new snapshot.
- Large pages: pass `max_chars`, or `ref` to scope the read to one subtree.
- `interactive:true` lists only actionable elements.

## Screenshots and PDFs

Both tools return a path on the machine running the daemon. Read the file with your own file tool; do not expect image bytes in the response. A caller-supplied `path` is honored (parent directories are created, existing files are overwritten).

## Errors and recovery

- `extension_not_connected` — Chrome/extension side is down. Tell the user; do not retry in a loop.
- `timeout` — the page is busy, closed, or blocked by a dialog. Check `list_tabs`, then try `dialog`.
- `tab_not_owned` — the current tab was borrowed. Use `newTab:true`/`adopt:true` before navigating, or `force:true` before closing.
- `extension_error` — the tool itself failed; the message is actionable (bad selector, expired ref, no tab).
- "A JavaScript ... dialog is open" — call `dialog` with `accept` or `dismiss`, then retry the action.
- Unknown tool — the daemon and extension versions disagree; tell the user to reload the extension.

## Rules

- Only `http://` and `https://` URLs.
- Prefer `snapshot` + refs; use `evaluate` only when the tree has no suitable target.
- Do not close tabs or sessions the user did not ask to close.
- Treat this as acting with the user's full browser identity: no destructive actions on banking, email, or admin pages without explicit confirmation.
- Never run `kai-webbridge stop` or change the daemon address while a task is in progress.
