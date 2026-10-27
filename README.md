# knot - serverless peer-to-peer chat room

Browser-only chat: WebRTC data channels between devices, no application server,
no build step, no dependencies. Messages are signed, rooms are end-to-end sealed
wherever a third party is involved, and the app still works when public
signaling brokers are blocked (manual QR / text pairing).

## Run

    node tools/serve.mjs 8080        # then open http://localhost:8080
    npm test                         # unit tests (Node 22+)
    PLAYWRIGHT_MODULE=/path/to/node_modules/playwright npm run test:e2e

CI (`.github/workflows/ci.yml`): unit tests and the headless-Chromium tests run on every
push and pull request. Only a push to `main` whose unit and browser tests both pass is
published to GitHub Pages (one-time: Settings > Pages > Source: GitHub Actions).

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
      files/image.js       image sniffing, sender-side thumbnail/preview derivation
      files/preview-cache.js  per-room LRU cache of previews (IndexedDB)
      qr/qr.js             QR encoder (verified against OpenCV in tests)
      ui/                  DOM helpers, i18n (en/zh/de), views, camera scanner
      ui/image-card.js     one image in the log: thumbnail, preview, original
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
* **Image previews:** an image is announced with a ~160 px thumbnail (<= 10 KB)
  inside the signed envelope, so it shows at once, survives an offline sender and
  travels with history sync. A <= 1280 px preview (<= 600 KB) is a second, content-addressed
  "file" whose size and SHA-256 are in the envelope; it is fetched when the message
  scrolls into view (Settings: auto / on tap / off), cached per room, and any peer that
  has it can serve it. Originals <= 300 KB are their own preview. The full original is
  loaded only on request. Peers sniff bytes instead of trusting mime types and check the
  pixel count from the header before decoding. SVG is shown only through `<img>` (never as a
  document), rejected with scripts/entities, and only when received whole (<= 2 MB).
* **Owner and membership:** a room made now has an owner (its creator) who admits everyone.
  Members are a chain of owner-signed envelopes (`admit`, `revoke`, `transfer`, each naming
  the previous one in `prev`, so clocks do not matter and a removed owner cannot backdate).
  A link carries only a *lobby* secret (derived one-way from the room secret, bound to the
  owner's id): it reaches the owner, it cannot read the room. The joiner sends a signed
  greeting plus a one-time X25519 key; the owner answers with the room secret sealed to
  that key and signed. Pairing by an owner-made code counts as approval. Peers talk chat
  only with identities in the chain (others are dropped after `adminTimeoutMs`), the
  chain is never trimmed, and a removed identity is refused at once. The owner can also
  delete anyone's message and hand the room to a member (`transfer`; old join links then
  stop working, trust stays rooted in the creator's id). Rooms made before this update
  have no owner and stay open to anyone with the link.
  Known gap: everyone who ever held the room secret (including a removed member) can read
  text relayed through the brokers, and a leaked secret lets someone sit in on that relay;
  P2P links are protected by the membership check. Rotating a relay key on removal is next.
* **Attachments:** pasted, dropped and picked files wait in the message box (chips with a
  preview and a remove button) and are sent, to everyone, only with Enter or Send: files
  first, then the text. The message box grows with its text up to a cap.
* **Delete and quote:** a `del` envelope (signed by the author, naming one of the
  author's own message ids) makes every peer drop that message's content from memory
  and storage and show "<name> deleted a message" in its place; a copy that arrives
  later is refused. A deleted file is no longer offered and its cached preview is
  purged. It cannot take back what was already downloaded, or what a modified client
  keeps. `reply` envelopes carry a snapshot of the quoted message (id, name, 200 chars);
  the UI hides the snapshot once the original is deleted.
* **Connection reveal:** hold V (or press and hold the member strip) to see per member:
  direct / through NAT / TURN-relayed, candidate types, protocol, round-trip time and
  how they were found (`PeerLink.stats()` from `RTCPeerConnection.getStats()`).
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
