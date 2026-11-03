# Third-party notices

Kai WebBridge is MIT-licensed. It has one runtime dependency.

## ws

- Package: `ws`
- Version range: `^8.18.0`
- License: MIT
- Repository: https://github.com/websockets/ws

```text
Copyright (c) 2011 Einar Otto Stangvik <einaros@gmail.com>
Copyright (c) 2013 Arnout Kazemier and contributors
Copyright (c) 2016 Luigi Pinca and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Node.js built-ins and Chrome

The daemon runs on Node.js and the extension uses Chrome extension APIs. Neither is
bundled or redistributed by this project. Chrome for Testing, used only by the test
suite, is downloaded separately by `scripts/fetch-chrome.mjs` under its own terms.

## No proprietary assets

No code, skill text, icons, screenshots, or other assets from Kimi WebBridge or any
other browser bridge are included in this repository.
