# Testing and CI

[Back to the README](../README.md)

## Unit tests

    npm test                         # unit tests (Node 22+)
    npm run test:soft                # the same with the TweetNaCl fallback curves

Fakes for the network, the DOM and calls are in `test/fakes.js`, `test/fake-dom.js` and
`test/call-fakes.js`.

## Browser tests

    npm install --no-save playwright && npx playwright install   # once
    npm run test:e2e                 # Chromium: the full suite (fake camera and microphone)
    npm run test:e2e:all             # that, then the Firefox and WebKit engine suites, as installed
    npm run test:e2e:webkit          # one browser's engine suite; or :firefox

Playwright is found in this project, the global npm folder or the cache of `npx`;
`PLAYWRIGHT_MODULE=/full/path/to/playwright` overrides that (a real path, not a placeholder).

Two suites (`test/e2e/browsers.mjs`):

* *Full* (Chromium only, which has a fake camera and microphone): real WebRTC between two pages,
  calls, layout.
* *Engine* (any browser): the checks of a single page, namely the UI, two rooms paired inside one
  page (text, edit, reaction, image thumbnail and preview, original, delete) and the lab page.

`E2E_SUITE` overrides the default (full in Chromium, engine elsewhere).

`E2E_BASE_URL=https://host/path/ npm run test:e2e` runs the *live* suite (the UI and the lab page)
against a deployed site instead of this checkout; the deploy jobs use it as their smoke test.

## CI and deploy

`.github/workflows/ci.yml` runs on every push and pull request: unit tests, then the browser tests
(the full suite in Chromium, the engine suite in Firefox and WebKit). Only Chromium blocks a deploy
for now (`continue-on-error` on the others, see the comment in the file).

A push to `main` whose unit tests and Chromium tests pass is published to GitHub Pages as the
**beta** copy (one-time: Settings > Pages > Source: GitHub Actions) and smoke-tested there.
**Production** is Cloudflare, deployed by `release.yml` from a tag `vX.Y.Z` once the commit has
soaked on beta; see [RELEASING.md](../RELEASING.md). Both are made by `tools/assemble.sh`.

## Call quality tests

`test/quality-sim.js` models one sender's uplink (a bandwidth estimate that follows the capacity
with a lag, a queue, then loss) and `quality-sim.test.js` runs the controller through it for
browsers that report nothing extra, a limit reason, or a bandwidth estimate: a rich link, 600
kb/s, a collapse and a recovery, a hopeless link, five connections on 1 Mb/s. It checks the
behaviour (settles, does not flap, short queue, video returns), not a real network: for that,
`sudo tools/netshape.sh weak|lte|lossy|hopeless|cycle` shapes this Mac's UDP traffic (macOS,
dummynet + pf; `off` restores) while you call from another device, and Settings > Diagnostics
shows what the call did.

Check Chrome, Firefox and Safari with 2, 4 and 6 people.

## Verified so far

* Unit tests; the full browser suite in Chromium; the engine suite in Firefox (CI) and WebKit
  (CI on Linux, Playwright's WebKit 27.2 on macOS).
* Playwright's Firefox does not start on one macOS machine (Node 26.10: "Could not find profile
  folder", also after a forced reinstall); `npm run test:e2e:all` skips it.
* Not verified: real public brokers, phones, mainland China networks.
* Safari: image previews and message deletion were reported failing on some macOS/Safari versions
  and working on others (maybe version-related, not investigated further); Settings >
  Diagnostics shows what a given Safari supports.
