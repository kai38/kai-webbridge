# Chrome Web Store listing

Copy for the Chrome Web Store dashboard. The extension ZIP is built with
`npm run package:extension`.

## Basic fields

- **Name:** Kai WebBridge
- **Short description (132 char max):**
  `Drive your real Chromium browser from a local agent. Snapshot pages, click, type, screenshot, save PDFs. Local-only.`
- **Category:** Developer Tools
- **Language:** English
- **Homepage:** https://github.com/kai38/kai-webbridge
- **Support URL:** https://github.com/kai38/kai-webbridge/issues
- **Privacy policy:** https://github.com/kai38/kai-webbridge/blob/main/PRIVACY.md
- **Visibility:** Unlisted first; switch to Public after review.

## Detailed description

Kai WebBridge connects a local agent to the browser you already use. It is not a
headless browser and not a cloud service: a small daemon runs on `127.0.0.1`, and this
extension executes commands in your real tabs, with your real logins.

What it can do:

- Open pages and collect each task's tabs into a visible tab group.
- Attach to pages the user already has open, without moving or closing them.
- Read the page as an accessibility tree with stable `@e` element references.
- Click, type, scroll, upload files, and handle JavaScript dialogs.
- Take screenshots and save pages as PDFs to local files.
- Run JavaScript and raw Chrome DevTools Protocol commands when the local agent asks.
- Capture network requests for a tab while capture is enabled.
- Numbered interactive map and full-page screenshot whenever a page is opened, attached,
  or resumed.
- Batch actions such as `!2:t:"text",1:c!` fill and click several elements in one call.
- Resume a task after a daemon restart; a status side panel shows the connected browser and
  daemon state.

Privacy:

- No accounts, analytics, telemetry, ads, or cloud component.
- Page data is processed locally by the daemon on your machine.
- The daemon listens on `127.0.0.1` only.
- The source is MIT-licensed and auditable.

Requirements:

- A Chromium-based browser (Chrome, Edge, Brave, Opera, or Vivaldi) 120+.
- Node.js 20+ and the Kai WebBridge daemon:
  `npx -y kai-webbridge setup`.
  The command installs the daemon, copies this extension to a stable folder, and starts
  the local service. Load the printed folder with "Load unpacked".

The extension is a companion for the open-source daemon. It does nothing without the
daemon running.

## Single-purpose statement

Kai WebBridge is a local bridge that lets the user's own agent control the user's
signed-in Chromium browser. All features exist to observe and act on web pages on
behalf of that local agent.

## Permission justifications

- **debugger:** Core function. Attaches to the tab the user is working with to read the
  accessibility tree, capture screenshots and PDFs, and dispatch input. Access is
  limited to the current task's tabs.
- **tabs:** Open, select, list, group, and close the tabs that belong to a task; read
  their titles and URLs so the agent can find the right tab.
- **tabGroups:** Put a task's tabs into one visible group, named by the agent, so the
  user can see and close them together.
- **storage:** Remember the daemon address, optional token, client ID, and the
  tab-group bindings used to restore a task after a daemon restart.
- **alarms:** Reconnect the extension's WebSocket after Chromium suspends the extension
  service worker.
- **sidePanel:** Show the connection/status panel in Chrome's side panel. It stays visible
  across tabs and does not read page content.

No host permissions are requested. Navigation, debugging, and tab access use the
permissions above only.

## Remote code justification

The extension ships all of its logic. It does not load remote scripts, use `eval`, or
build an interpreter. Page-level JavaScript and DevTools Protocol calls are executed
through the `chrome.debugger` API, which Chromium's Manifest V3 policy explicitly
permits for controlled execution. Commands originate from a daemon the user installs
and runs on their own machine; there is no developer-operated server.

## Data usage disclosures

- No data is sold or transferred to third parties.
- No data is used for advertising, analytics, or creditworthiness.
- Page content, tab URLs, screenshots, and PDFs are processed locally only.
- The extension does not collect credentials. It can act inside pages where the user is
  already signed in, as the user.
- Limited Use: data is used only to provide the user-facing browser-control features.

## Reviewer test instructions

1. Install Node.js 20 or newer.
2. Run `npx -y kai-webbridge setup` in a terminal. This starts the daemon on
   `127.0.0.1:10087` and copies the extension to `~/.kai-webbridge/extension`.
3. Load that folder with "Load unpacked" in `chrome://extensions`.
4. Open the extension side panel (click the toolbar icon or press Ctrl+Shift+Y) and the Options page. Both should show "connected" and the browser name.
5. Open `https://example.com`, then from a terminal run:

   ```bash
   npx -y kai-webbridge status
   ```

   The response must include `"extension_connected": true` and an
   `extension_browser` object.

6. To exercise browser control without curl:

   ```bash
   node -e "fetch('http://127.0.0.1:10087/command',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'navigate',args:{url:'https://example.com',newTab:true,group_title:'Review'},session:'review'})}).then(r=>r.json()).then(console.log)"
   ```

   A tab opens, grouped as "Review". The daemon response contains `tabId`.

7. Stop the daemon with `npx -y kai-webbridge stop` and remove
   `~/.kai-webbridge/` after testing.

The Chrome Web Store pages themselves cannot be scripted by extensions; this is a
Chromium restriction, not a test failure.

## Assets checklist

- [x] 128×128 store icon: `extension/icons/128.png`
- [x] Extension ZIP: `dist/kai-webbridge-extension-0.1.5.zip`
- [x] At least one 1280×800 screenshot: `docs/store/screenshots/options-1280x800.png`
- [x] 440×280 small promo tile: `docs/store/promo-440x280.png`
- [x] Privacy policy URL
- [x] Permission justifications
- [x] Reviewer test instructions

## Submission steps

1. Register the Chrome Web Store developer account and pay the one-time fee.
2. Complete Publisher Settings: display name, verified contact email, trader
   declaration, public postal address.
3. Create a new item, upload the ZIP, paste the listing fields above.
4. Upload screenshots, select Unlisted, submit for review.
5. After approval, switch visibility to Public.
