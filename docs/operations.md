# Running it

Networks, brokers, storage, updates and diagnostics: what keeps a deployed copy working and how to
see why it does not.

[Back to the README](../README.md)

## Broker health

At startup every configured broker is probed (WebSocket and MQTT CONNACK, with its time, then a
loopback: subscribe to a probe topic, publish to it, wait for the message to come back), like
STUN. Channels connect to the fast ones first; a broker whose probe failed is left alone (a retry
only every minute or so, at once if a real connection works) and probed again every five minutes.
A broker that connects but refuses a subscription (SUBACK failure or none within 8 s) or does not
relay is down too, shown as "does not pass messages on"; a connection alone does not clear that,
only a passing probe does. Settings shows each broker with its time, "not reachable" or "does not
pass messages on", with a *Check brokers* button. The lab runs the same probe.

## Install icons

iOS ignores the manifest and wants `apple-touch-icon.png` (180 px); Chrome wants 192 and 512 px
PNGs to offer an install, and a maskable one. On Safari only an app on the Home Screen keeps its
storage. `tools/make-icons.py` (Pillow) draws them from the same shapes as `icons/icon.svg`.

## When the app does not start

`index.html` shows "Loading…" until the app is on screen, and loads `src/boot-guard.js` first (a
classic script: a module that fails to load must not take it down too). After 10 s, or when
`main.js` fails, it replaces "Loading…" with what the app waits for (storage, other tabs, identity,
rooms: *n of m (name)*, screen), the errors it saw (a script that did not load, a security-policy
block, a rejected promise), a hint for each, and three buttons: *Reload*, *Repair* (unregisters the
service worker and deletes its caches; rooms and messages are not touched) and *Show report*. A
file that fails to load triggers one automatic repair per visit, and only online.

What makes a page stay on "Loading…", most likely first: (1) a file of the app did not load or
the files are from two versions (the service worker answers from its cache when the network is
slower than 4 s, one file at a time); (2) `indexedDB.open` never answers (an installed app after a
restart on Safari, another connection stuck; it now fails after 20 s with a reason); (3) another
tab holds the instance lock (the page says so instead); (4) a room that will not open (it is
skipped and named in a notice and in Diagnostics; its entry stays in the list); (5) a very long
history on a slow device (the stage names the room).

## Coming back to the page

A phone suspends sockets and links without a sound. When the page was hidden for 10 s or more and
shows again, when the browser is back online, and when a page is restored from the cache or
resumed (`src/wake.js`), every broker socket is replaced at once (a connection waiting to retry
stops waiting) and each synced link sends its `have`, so what was missed arrives. A WebRTC link
(chat or call) that stays `disconnected` for 8 s is closed, so the room falls back to the brokers
and the peer is dialed again. Changing the broker list or the brokers switch in Settings (or on a
linked device) reconnects running rooms; no reload is needed.

## Keeping your data

The page asks the browser for persistent storage (`navigator.storage.persist()`) at the first
click; Settings says whether it was granted and can ask again. Without it the browser may delete
the identity key and history when space is low (Safari: after about a week without a visit unless
the app is installed to the Home Screen or Dock). The key cannot be recovered.

Settings > *Your data on this device* explains this and shows the state: *Protected*, *Not
protected* (with hints: install the app, open it regularly, allow a permission prompt, export
chats, keep recovery codes) or *cannot be asked* (no `navigator.storage.persist`). *Keep my data*
asks again and answers in the dialog itself: "Asking the browser...", then "Done" or "did not
agree this time". Browsers often refuse without any prompt (Chrome by engagement, Safari unless
installed), so a refusal is normal and not an error. Persistent storage does not survive the user
clearing site data or removing the app.

## Updates

The deploy stamps the commit into `index.html` (`<meta name="build">`) and writes `build.json`
({"build": "<commit>"}). The page compares the two every 15 minutes and when you return to the tab
(at most once a minute); when they differ, a bar offers "Reload" (and asks first during a call). A
static page cannot update itself. Without the stamp (local development, tests) nothing happens,
not even a request.

## Diagnostics

Settings > Diagnostics makes a text report for when something works in one browser and not in
another: the browser, what it supports (WebRTC, Ed25519 and X25519, image encoding, IndexedDB
buffers...), every room's links (direct, relayed), the brokers and the last errors the page hit.
It holds no messages or keys. A JPEG thumbnail (the only format Safari encodes) may be up to 9 KB;
a failing OffscreenCanvas falls back to a page canvas.

## China

No Google/Firebase/CDN dependency, STUN servers reachable from the mainland first, runtime ranking
of STUN servers, TURN over TLS 443 supported through Settings (host it outside the mainland;
operating infrastructure inside needs an ICP licence), manual pairing as the last resort.
