# Kai WebBridge

[![CI](https://github.com/kai38/kai-webbridge/actions/workflows/ci.yml/badge.svg)](https://github.com/kai38/kai-webbridge/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/kai-webbridge.svg)](https://www.npmjs.com/package/kai-webbridge)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Open-source browser bridge for local AI agents.** Let an agent drive your real Chrome — your tabs, your cookies, your logins — through a small local daemon and a Manifest V3 extension.

No cloud service, no headless browser, no telemetry. The agent talks HTTP to `127.0.0.1`; the extension executes commands with `chrome.debugger`.

```
Agent (Claude Code, Codex, Kimi CLI, …)
  │  POST http://127.0.0.1:10087/command   {"action","args","session"}
  ▼
Kai WebBridge daemon (Node.js)  ──  sessions, output files, optional token
  │  WebSocket ws://127.0.0.1:10087/ws     hello / tool_call / tool_result
  ▼
Chrome extension (MV3)  ──  chrome.debugger → CDP → your real tab
```

## Install

Requirements: **Node.js 20+**, **Chrome/Chromium 120+**.

### npm (recommended)

```bash
npx -y kai-webbridge setup
```

Or install the CLI globally:

```bash
npm install -g kai-webbridge
kai-webbridge setup
```

`setup` downloads nothing else: the npm package already contains the extension and skill.

### From a checkout

```bash
git clone https://github.com/kai38/kai-webbridge.git
cd kai-webbridge
npm install
node bin/kai-webbridge.js setup
```

Release tarballs are also attached to every GitHub release for offline installs.

### What `setup` does

1. Copies the agent skill into detected runtimes (`~/.claude`, `~/.codex`, `~/.kimi-code`) and `~/.kai-webbridge/skills`.
2. Copies the extension to a **stable path**, `~/.kai-webbridge/extension`, so Chrome keeps the same extension ID across upgrades.
3. Starts the daemon on `127.0.0.1:10087`.
4. Prints the extension folder to load.

Flags: `--no-start` (configure only), `--no-skill` (skip agent runtimes), `--port`, `--token`, `--home`.

### Load the extension (one manual step)

Chrome only allows unpacked extensions to be loaded from its own UI:

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select `~/.kai-webbridge/extension` (the exact path is printed by `setup`).

### Verify

```bash
kai-webbridge status
```

`extension_connected: true` means the daemon and browser are talking. If the extension shows an error, open its **Options** page and confirm the WebSocket URL is `ws://127.0.0.1:10087/ws` (or the port you configured).

After updating the checkout, run `kai-webbridge setup` again to refresh the extension copy and skill, then reload the extension in `chrome://extensions`.

## Try it

```bash
curl -s -X POST http://127.0.0.1:10087/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"navigate","args":{"url":"https://example.com","newTab":true,"group_title":"Example"},"session":"demo"}'

curl -s -X POST http://127.0.0.1:10087/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"snapshot","args":{"format":"aria"},"session":"demo"}'
```

The snapshot returns lines like `- link "More information..." [ref=e4]`. Use `@e4` as the target:

```bash
curl -s -X POST http://127.0.0.1:10087/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"click","args":{"selector":"@e4"},"session":"demo"}'

curl -s -X POST http://127.0.0.1:10087/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"screenshot","args":{"format":"jpeg","quality":70},"session":"demo"}'
# → {"ok":true,"data":{"path":"/tmp/kai-webbridge-screenshots/...jpg", ...}}

curl -s -X POST http://127.0.0.1:10087/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"close_session","args":{},"session":"demo"}'
```

## Tools

| Category | Tools |
|---|---|
| Tabs | `navigate`, `find_tab`, `list_tabs`, `close_tab`, `close_session` |
| Observe | `snapshot`, `read_page`, `wait` |
| Act | `click`, `mouse_click`, `fill`, `scroll`, `upload`, `dialog` |
| Run | `evaluate`, `cdp` |
| Capture | `screenshot`, `save_as_pdf`, `network` |

Full request/response reference: [docs/protocol.md](docs/protocol.md). The agent-facing contract is [skill/kai-webbridge/SKILL.md](skill/kai-webbridge/SKILL.md).

## Sessions

One task = one session = one Chrome tab group. The `session` field goes at the **top level** of the request body:

```json
{"action":"navigate","args":{"url":"https://example.com","group_title":"Research"},"session":"research"}
```

The daemon remembers the session's current tab and injects internal `_session`, `_tabId`, and `_ownedTabIds` fields. The extension groups the tabs visibly under the group title, and `close_session` closes the whole group. Tabs survive a daemon restart because the extension keeps the group binding.

## Configuration

`~/.kai-webbridge/config.json` (all keys optional):

```json
{
  "host": "127.0.0.1",
  "port": 10087,
  "token": "optional-shared-secret",
  "commandTimeoutMs": 120000,
  "extensionWaitMs": 29000,
  "outputDir": "/tmp",
  "logLevel": "info"
}
```

CLI flags override the file: `--host`, `--port`, `--token`, `--output-dir`, `--log-level`, `--home`.

If `token` is set, commands must send `Authorization: Bearer <token>` and the extension must be configured with the same token.

## Security, in one paragraph

The extension can read and control every tab (it needs the `debugger` permission). The daemon accepts only local connections, ignores any `/command` request that carries an `Origin` header (so web pages cannot drive it), and optionally requires a bearer token. It has no telemetry. Treat the agent exactly as you would treat a person at your keyboard. Details: [docs/security.md](docs/security.md).

## Development

```bash
npm install
npm test          # unit tests: protocol, sessions, outputs, daemon HTTP/WS
npm run test:e2e  # real Chrome + extension + daemon round trip
```

The e2e test needs [Chrome for Testing](https://developer.chrome.com/blog/chrome-for-testing/) because Google Chrome 137+ ignores `--load-extension`:

```bash
npm run fetch-chrome
npm run test:e2e
```

The suite runs headless and covers navigation, snapshot refs, fill, click, contenteditable, screenshots, PDF, network capture, upload, dialogs, tab grouping, and session close. See [CONTRIBUTING.md](CONTRIBUTING.md) before sending a pull request.

## Project layout

```
bin/            CLI entry
src/            daemon (config, sessions, hub, HTTP, outputs, CLI)
extension/      Manifest V3 extension (no build step)
skill/          agent skill installed by `setup` / `install-skill`
test/unit/      fast tests without a browser
test/e2e/       headless Chrome integration test
docs/           architecture, protocol, security
.github/        CI workflow
```

More: [architecture](docs/architecture.md) · [protocol](docs/protocol.md) · [security](docs/security.md).

## Limitations

- Top frame only: `snapshot`/`click`/`fill`/`evaluate` do not traverse cross-origin iframes (use `cdp` or navigate the frame URL).
- `click`/`fill` dispatch DOM-level events, so pages that strictly require `isTrusted` may ignore them; `mouse_click` and `cdp` use real CDP input for those cases.
- One browser per daemon. A second extension connection is refused with WebSocket close code `4409`.
- No multi-agent isolation: sessions are names, not security boundaries.
- HTTP/HTTPS only; `file://` and `chrome://` navigation is refused.
- Cross-platform code exists, but automated e2e is currently verified on Linux.

## Independence and trademarks

This is an independent, from-scratch implementation. It is **not affiliated with, endorsed by, or sponsored by Moonshot AI**, and it contains no code, skill text, icons, or other assets from the Kimi WebBridge product. The names "Kimi", "Kimi WebBridge", and "Chrome" are trademarks of their respective owners, used only to describe prior art or the runtime this project talks to.

## License

MIT — see [LICENSE](LICENSE). Third-party notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
