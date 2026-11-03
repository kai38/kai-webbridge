# Privacy Policy — Kai WebBridge

**Effective date:** 2026-11-03

Kai WebBridge is a local browser bridge. It does not collect, transmit, sell, or share
personal data. There is no telemetry, analytics, crash reporting, advertising, or cloud
service.

## What the extension can access

The extension uses Chromium's `debugger`, `tabs`, `tabGroups`, `storage`, and `alarms`
APIs. While a command is running it can access:

- tab titles, URLs, and tab-group membership;
- the page's accessibility tree and DOM;
- screenshots and PDF renderings of the page;
- page JavaScript execution results;
- network request metadata, when network capture is explicitly started.

This data is processed on the user's machine by the Kai WebBridge daemon at
`127.0.0.1:10087`. It is not sent to the developer or any third party.

## Storage and retention

- Screenshots and PDFs are written to the local filesystem (by default under the
  operating system's temporary directory). The user can delete them at any time.
- Daemon logs contain tool names, session names, durations, and error codes. They do not
  contain page content.
- Extension settings (daemon URL, optional token, client ID, and tab-group bindings) are
  stored in Chromium's local extension storage.
- Session names, tab IDs, borrowed state, and timestamps are stored locally in
  `~/.kai-webbridge/sessions.json` (mode 0600). URLs, titles, and page content are not
  stored there.
- The daemon may read page content to serve a request; it does not retain it beyond the
  request or the output files the user asks for.

## Network

The daemon binds `127.0.0.1` by default. The extension connects only to the daemon URL
configured in its options page. Kai WebBridge has no server component and makes no
requests to the developer.

## Third parties

No third-party services, SDKs, or trackers are included. The only runtime dependency is
the open-source `ws` package, which runs locally.

## Remote code

The extension package contains all of its logic. It does not load scripts from remote
servers. Commands that execute page JavaScript or raw Chrome DevTools Protocol calls are
received from the user-installed local daemon and are covered by Chromium's documented
Debugger API, not by downloading code into the extension.

## Children

The extension is a developer tool and is not directed at children.

## Changes

Material changes to this policy will be published in this file and noted in the
repository history.

## Contact

Open an issue at <https://github.com/kai38/kai-webbridge/issues>.
