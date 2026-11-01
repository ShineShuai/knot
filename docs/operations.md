# Running it

Networks, brokers, storage, updates and diagnostics: what keeps a deployed copy working and how to
see why it does not.

[Back to the README](../README.md)

## Broker health

At startup every configured broker is probed (WebSocket and MQTT CONNACK, with its time), like
STUN. Channels connect to the fast ones first; a broker whose probe failed is left alone (a retry
only every minute or so, at once if a real connection works) and probed again every five minutes.
Settings shows each broker with its time or "not reachable", with a *Check brokers* button.

## Keeping your data

The page asks the browser for persistent storage (`navigator.storage.persist()`) at the first
click; Settings says whether it was granted and can ask again. Without it the browser may delete
the identity key and history when space is low (Safari: after about a week without a visit unless
the app is installed to the Home Screen or Dock). The key cannot be recovered.

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
