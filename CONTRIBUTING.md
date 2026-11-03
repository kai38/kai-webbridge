# Contributing

Thanks for considering a contribution. This project is intentionally small: a Node
daemon, a buildless Manifest V3 extension, one agent skill, and tests. Keeping it that
way is part of the design.

## Ground rules

- **Local-first.** No cloud calls, accounts, analytics, or telemetry may be added.
- **No copied material.** Do not paste code, skill text, screenshots, icons, or docs
  from other browser bridges or proprietary products. Write it from scratch.
- **Buildless extension.** The files under `extension/` run as-is; no bundler, no
  transpiler, no minified output.
- **Small dependency surface.** New runtime dependencies need a clear justification.
  The daemon currently depends only on `ws`.
- **Security matters.** Changes to auth, the Origin guard, the WebSocket hub, or the
  extension permission model get extra review.

## Development setup

```bash
git clone https://github.com/kai38/kai-webbridge.git
cd kai-webbridge
npm install
npm test
npm run fetch-chrome   # once, for the e2e test
npm run test:e2e
```

Load `extension/` as an unpacked extension in a spare Chrome profile for manual testing.
For a stable install, run `node bin/kai-webbridge.js setup`; that copies the extension to
`~/.kai-webbridge/extension`.

## Pull requests

- Keep changes focused; one topic per pull request.
- Add or update tests for behavior changes.
- Update `docs/protocol.md` when the HTTP or WebSocket contract changes.
- Run `npm test` and, for browser-facing changes, `npm run test:e2e`.
- Describe the user-visible effect in the pull request body.

## Licensing and sign-off

This project is MIT-licensed and uses the
[Developer Certificate of Origin 1.1](https://developercertificate.org/) instead of a
CLA. Sign off every commit:

```bash
git commit -s -m "Your message"
```

The sign-off certifies that you wrote the contribution or have the right to submit it
under the project's MIT license. Contributions are accepted under the same MIT terms.

## Security issues

Do not open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md).
