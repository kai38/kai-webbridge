# Security Policy

## Supported versions

The latest `0.x` release on `main` receives security fixes. There are no long-term
support branches yet.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting:

**https://github.com/kai38/kai-webbridge/security/advisories/new**

Do not open a public issue, discussion, or pull request that describes an
unfixed vulnerability. Include:

- affected version or commit,
- operating system and Chrome version,
- a minimal reproduction,
- impact (what an attacker gains),
- whether the issue requires a malicious website, a local process, or physical access.

You can expect an acknowledgement within a few days. A fix and advisory will be
published together; credit is given unless you prefer to stay anonymous.

## Scope

In scope:

- the daemon (`src/`) — HTTP API, WebSocket hub, authentication, Origin guard, file
  writes, CLI;
- the extension (`extension/`) — debugger attachment, tool implementations,
  permission model, message handling;
- the agent skill (`skill/`) — instructions that could cause unsafe actions;
- packaging and install scripts.

Out of scope:

- vulnerabilities in Chrome or Chrome's debugger protocol,
- a compromised agent runtime or model provider,
- a user intentionally running the daemon with `host: 0.0.0.0` or handing the token to
  an untrusted process,
- phishing or prompt-injection scenarios that rely on the agent ignoring its own
  instructions (report those as design feedback, not vulnerabilities).

## Design notes for reviewers

- The daemon binds `127.0.0.1` by default and sends no telemetry.
- `/command` ignores requests that carry an `Origin` header (anti-CSRF).
- The optional bearer token protects both HTTP commands and the extension WebSocket.
- The extension requires the `debugger` permission, so it can read and modify any tab.
  This is disclosed in the README and [docs/security.md](docs/security.md).
- A second browser connection is refused with WebSocket close code `4409`; a foreign
  extension protocol is refused with `4400`.
