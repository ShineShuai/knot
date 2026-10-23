# knot - serverless peer-to-peer chat room

Browser-only chat: WebRTC data channels between devices, no application server,
no build step, no dependencies. Messages are signed, rooms are end-to-end sealed
wherever a third party is involved, and the app still works when public
signaling brokers are blocked (manual QR / text pairing).

## Run

    node tools/serve.mjs 8080        # then open http://localhost:8080
    npm test                         # unit tests (Node 22+)
    PLAYWRIGHT_MODULE=/path/to/node_modules/playwright npm run test:e2e

Any static host works for deployment (HTTPS required outside localhost). Host it
on two or three origins and also hand out the folder as a ZIP: after one visit
the service worker serves the app offline. Nothing is loaded from a CDN.

Open `/lab/lab.html` on each network you care about (e.g. in China). It tests
STUN servers, NAT type, MQTT brokers and a real WebRTC pairing, and prints a
report you can share. Use it to tune `stunServers` / `brokers` in `src/config.js`.

## How two devices connect

1. **Manual (no server at all).** A taps *Invite -> Create pairing code*, shows
   the QR or sends the text. B taps *Join*, scans or pastes it and gets a reply
   code (QR or text) to give back. A enters the reply. Both screens then show
   the same 6-digit number; compare it aloud to rule out a swapped code.
2. **Room link.** `https://host/#r=<secret>`. Everyone holding the secret finds
   each other through public MQTT brokers (rendezvous only) and then connects
   directly. The secret stays in the URL fragment and is never sent anywhere.

Both paths end in the same place: a direct WebRTC link. Paths can be combined,
and a code can be used once only (a fresh exchange is needed after a link dies
if no broker is reachable; with brokers, reconnection is automatic).

## Module map

    src/
      config.js            defaults: STUN, brokers, limits (overridable in Settings)
      app.js               AppModel: identity, settings, set of rooms
      main.js              boot
      util/                bytes (base64url, binary writer/reader), hlc, rate limiter
      crypto/identity.js   Ed25519 device key (non-extractable, IndexedDB)
      crypto/room-keys.js  room secret -> HKDF -> topic id + AES-GCM key
      net/sdp.js           SDP <-> compact SdpInfo (data-channel-only)
      net/handshake.js     signed offer/answer, ~300-char code, short auth string
      net/peer-link.js     one RTCPeerConnection: "chat" + "files" channels
      net/mqtt.js          minimal MQTT 3.1.1 client over WebSocket
      net/room-channel.js  presence, signaling, text relay over brokers (sealed)
      net/ice-probe.js     STUN ranking, NAT type probe
      chat/envelope.js     signed chat message format + verification
      chat/log.js          ordered, de-duplicated, capped message log + sync delta
      chat/room.js         Room: ties links, brokers, log, files together
      files/transfer.js    chunked P2P file transfer with SHA-256 check
      qr/qr.js             QR encoder (verified against OpenCV in tests)
      ui/                  DOM helpers, i18n (en/zh/de), views, camera scanner
    lab/                   network lab page
    test/                  unit tests (+ fakes) and real-Chromium e2e

## Design notes

* **Identity:** each device has an Ed25519 key; peer id = first 8 bytes of
  SHA-256(public key). Handshakes are signed, so the identity vouches for the
  DTLS fingerprint. Chat messages are signed and carry their author; any peer
  or relay path can deliver them and anyone can verify them.
* **Ordering:** hybrid logical clock; far-future stamps are rejected/clamped.
* **History:** on every new link both sides exchange the ids of their recent
  messages and send what the other lacks. Messages are gossiped to other links
  so a missing mesh edge heals. The log is a FIFO of `logCap` messages.
* **Relay fallback:** while some known room member has no direct link, text is
  also published, AES-GCM sealed, on the room's broker topic. Files never use it.
* **Glare:** the peer with the smaller id always makes the offer.
* **Hardening:** CSP without inline code, all text via `textContent`, rate
  limit per link, size/shape validation of every envelope, replay protection for
  pairing codes (10 min TTL, single use), `wss://` only for brokers.
* **China:** no Google/Firebase/CDN dependency, STUN servers reachable from the
  mainland first, runtime ranking of STUN servers, TURN over TLS 443 supported
  through Settings (host it outside the mainland; operating infrastructure
  inside needs an ICP licence), manual pairing as the last resort.

## Not done / known limits

* Public MQTT brokers are QoS 0, online-only: no offline store-and-forward
  (a Nostr transport was planned; it needs secp256k1 Schnorr and is a clean
  addition behind `RoomChannel`'s interface).
* No forward secrecy for broker-relayed text (static room key). MLS is the
  upgrade path. Anyone with the room secret can join; there is no admin role.
* Brokers see metadata (topic id, message sizes/timing), not content.
* No in-band renegotiation, ICE restart or media. A dropped link reconnects only
  through brokers or a new code.
* Files: whole file in memory (default cap 100 MB), no resume.
* One tab per room should be open; multi-tab coordination is not implemented.
* Verified: unit tests, real WebRTC in headless Chromium. Not verified: real
  public brokers, Firefox/Safari, phones, mainland China networks.
