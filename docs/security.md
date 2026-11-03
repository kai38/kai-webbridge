# Security

Kai WebBridge hands an AI agent the same browser access you have. That is the point,
and also the risk. This document states the trust model and the controls that exist, so
you can decide when to run it.

## Trust model

- The daemon runs as **your OS user** and accepts commands from any process that can
  reach `127.0.0.1:10087`.
- The extension holds the Chromium `debugger` permission and can attach to the tabs the
  user opens. It requests no host permissions. Once attached, it can read and modify
  that tab, including logged-in sites.
- The agent is trusted to the same degree as a person at your keyboard. A prompt
  injection that reaches the agent is effectively a request from you.

There is no sandbox between the agent, the daemon, and the browser.

## Controls

### Network exposure

- The daemon binds `127.0.0.1` by default. Do not bind `0.0.0.0` unless you understand
  the consequences.
- No CORS headers are sent, so a web page cannot read responses from the daemon.
- `POST /command` **ignores any request carrying an `Origin` header**, returning `200`
  with an empty body. Browsers attach `Origin` to cross-origin requests; CLI tools do
  not. This blocks both website CSRF and other Chrome extensions from calling
  `/command` through `fetch`, because extension requests carry
  `Origin: chrome-extension://…`.
- WebSocket upgrades require the Kai WebBridge handshake (`protocol: 1` and
  `client: "kai-webbridge"`). Foreign extensions are closed with `4400`; a second
  browser is refused with `4409`.
- `GET /status` and `GET /health` are unauthenticated. `/status` exposes session names,
  tab counts, versions, and PIDs, but not URLs or page content.

### Authentication (optional)

Set `token` in `~/.kai-webbridge/config.json`:

```json
{"token": "long-random-string"}
```

- HTTP: `Authorization: Bearer <token>` (or `X-Kai-Token: <token>`).
- WebSocket: `?token=<token>`; the extension's options page stores it.
- Comparison uses `crypto.timingSafeEqual`.

The token stops other local processes from issuing commands. It does not stop a process
that can read your config file or extension storage.

### Data handling

- **No telemetry.** The daemon has no analytics, crash reporting, or update pings.
- Logs contain timestamps, session names, tool names, durations, and error codes. They
  do not contain args, page content, or URLs by default. Debug logs can include file
  paths for written outputs.
- Screenshots and PDFs are written to the OS temp directory by default
  (`<tmp>/kai-webbridge-screenshots`, `<tmp>/kai-webbridge-pdfs`) or to a caller-supplied
  path. They inherit your umask; treat them as sensitive.
- The extension stores the server URL, optional token, client UUID, and tab-group
  bindings in `chrome.storage.local`.

### Process and file scope

- The daemon has no privileged operations; it only reads/writes config, logs, and
  output files, and talks to Chrome through the extension.
- The CLI does not auto-install browser extensions, modify Chrome policies, or download
  code.

## Threats

| Threat | Mitigation | Residual risk |
|---|---|---|
| A website tries to POST commands | `Origin` guard; no CORS | A local proxy that strips `Origin` would bypass it, but such a proxy already has local code execution. |
| Another local process sends commands | Optional token | Same-user processes are inside the trust boundary; use the token or a separate OS account. |
| Another Chrome extension calls the daemon | `Origin` guard blocks browser-originated HTTP; WS protocol discriminator blocks attaching | An extension with filesystem access could read the token from disk. |
| The wrong extension attaches | `protocol`/`client` handshake, close `4400` | A deliberately spoofing extension would pass; the daemon cannot attest the extension's identity. |
| Prompt injection drives destructive actions | Agent-side judgment; no built-in confirmation prompts | Add your own approval layer for production use. |
| Agent reads/exfiltrates logged-in data | Local-only transport; no telemetry | The agent runtime itself may send data to its model provider. That is outside this project. |
| Stale refs click the wrong element | Document keys, `isConnected` checks, re-snapshot errors | A page can still mutate between resolution and click. |
| Temp files persist after a task | Paths are returned to the caller | Clean up `kai-webbridge-screenshots`/`kai-webbridge-pdfs`; no automatic retention policy yet. |
| Chrome debugger banner exposes automation | Chrome shows "being debugged" | Expected and intentional. |

## Recommendations

1. Run the daemon only while you need it: `kai-webbridge start` / `kai-webbridge stop`.
2. Set a token if other users or automation share the machine.
3. Do not use the bridge on banking, brokerage, email, or admin consoles unless you are
   watching and accept the risk.
4. Review the skill you install; it is just Markdown and tells the agent what it may do.
5. Keep Chrome and the extension updated. There is no auto-update path for an unpacked
   extension; re-load it after pulling changes.
6. Treat screenshots, PDFs, and downloaded files as confidential.
7. If you suspect misuse, stop the daemon, disable/remove the extension, and rotate any
   credentials that were available in open tabs.

## Reporting

This is an open-source project. Report security issues privately to the maintainer
rather than opening a public issue with reproduction details.
