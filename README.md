# knot - serverless peer-to-peer chat room

Browser-only chat over WebRTC data channels: no application server, no build step, no dependencies
(one vendored fallback for old browsers).

* Messages are signed; rooms are end-to-end sealed wherever a third party (a broker) is involved.
* Every room has an owner who admits members; one identity can span several linked devices.
* Text, files, image previews, audio/video calls (mesh, up to 6 people).
* Works when the public signaling brokers are blocked: manual QR / text pairing.
* English, 中文, Deutsch.

## Run

    node tools/serve.mjs 8080        # then open http://localhost:8080
    npm test                         # unit tests (Node 22+)
    npm run test:e2e                 # browser tests (needs Playwright), see docs/testing.md

Any static host works for deployment (HTTPS required outside localhost). Host it on two or three
origins and also hand out the folder as a ZIP: after one visit the service worker serves the app
offline. Nothing is loaded from a CDN.

Open `/lab/lab.html` on each network you care about (e.g. in China). It tests STUN servers, NAT
type, MQTT brokers and a real WebRTC pairing, and prints a report you can share. Use it to tune
`stunServers` / `brokers` in `src/config.js`.

## How two devices connect

1. **Manual (no server at all).** A taps *Invite -> Create pairing code*, shows the QR or sends
   the text. B taps *Join*, scans or pastes it and gets a reply code (QR or text) to give back.
   A enters the reply. Both screens then show the same 6-digit number; compare it aloud to rule
   out a swapped code.
2. **Room link.** `https://host/#j=<lobby secret>.<owner id>`. Everyone holding the link asks the
   room owner to be let in (rendezvous through public MQTT brokers only); once admitted, devices
   connect directly. The link stays in the URL fragment and is never sent anywhere. Rooms made
   before owners existed use `#r=<secret>` and are open to anyone holding the link.

Both paths end in the same place: a direct WebRTC link. Paths can be combined, and a code can be
used once only (a fresh exchange is needed after a link dies if no broker is reachable; with
brokers, reconnection is automatic).

## Documentation

| Document | Covers |
|---|---|
| [docs/architecture.md](docs/architecture.md) | layers, module map |
| [docs/security.md](docs/security.md) | identity, owner and membership, key rotation, recovery, hardening, old browsers |
| [docs/messages.md](docs/messages.md) | ordering, history sync, relay, reactions, edits, deletes, image previews |
| [docs/devices.md](docs/devices.md) | linked devices, shared state, the one-tab rule |
| [docs/calls.md](docs/calls.md) | calls, video quality, screen share |
| [docs/ui.md](docs/ui.md) | dialogs, rooms, composer, links, unread, search, export, language |
| [docs/operations.md](docs/operations.md) | brokers, storage, updates, diagnostics, China |
| [docs/testing.md](docs/testing.md) | unit and browser tests, CI, what is verified |
| [RELEASING.md](RELEASING.md) | beta, soak, production, hotfix, rollback |

## Known limits

* Public MQTT brokers are QoS 0 and online-only: no offline store-and-forward. A Nostr transport
  was planned (needs secp256k1 Schnorr; a clean addition behind `RoomChannel`'s interface).
* No forward secrecy for broker-relayed text (static room key, rotated when a member is removed).
  MLS is the upgrade path. Rooms made before owners existed are open to anyone with the link.
* Brokers see metadata (topic id, message sizes and timing), not content.
* Chat links have no in-band renegotiation or ICE restart: a dropped link reconnects through the
  brokers or needs a new code. Calls offer a dead media connection again by themselves.
* Files: whole file in memory (default cap 100 MB), no resume; files never use the brokers.
* Calls: a mesh, so up to 6 people; two people behind strict NATs need a TURN server (Settings).
* Not verified: real public brokers, phones, mainland China networks; Safari image previews and
  message deletion on some versions. Details in [docs/testing.md](docs/testing.md#verified-so-far).
