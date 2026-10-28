# knot - serverless peer-to-peer chat room

Browser-only chat: WebRTC data channels between devices, no application server,
no build step, no dependencies. Messages are signed, rooms are end-to-end sealed
wherever a third party is involved, and the app still works when public
signaling brokers are blocked (manual QR / text pairing).

## Run

    node tools/serve.mjs 8080        # then open http://localhost:8080
    npm test                         # unit tests (Node 22+)
    PLAYWRIGHT_MODULE=/path/to/node_modules/playwright npm run test:e2e   # fake camera + mic

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
      version.js           the version shown in the room list (equal to package.json)
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
      net/ice-gather.js    wait for ICE candidates (shared by data and call connections)
      chat/envelope.js     signed chat message format + verification
      chat/log.js          ordered, de-duplicated, capped message log + sync delta
      chat/room.js         Room: ties links, brokers, log, files together
      files/transfer.js    chunked P2P file transfer with SHA-256 check
      files/image.js       image sniffing, sender-side thumbnail/preview derivation
      files/preview-cache.js  per-room LRU cache of previews (IndexedDB)
      call/call.js         CallManager: mesh call of one room, presence + signaling frames
      call/call-link.js    one audio+video RTCPeerConnection to one participant
      call/media.js        microphone / camera access (swappable in tests)
      qr/qr.js             QR encoder (verified against OpenCV in tests)
      ui/                  DOM helpers, i18n (en/zh/de), views, camera scanner
      ui/image-card.js     one image in the log: thumbnail, preview, original
      ui/call-view.js      the call window: tiles, microphone / camera / leave
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
  **Key rotation:** removing a member also moves the room to new broker keys (topic,
  presence, signalling, relay and join links all derive from the room secret mixed with a
  fresh per-removal secret). The owner commits to that secret's hash in the removal
  envelope and hands the secret to members over their authenticated P2P links; members pass
  it on, new joiners get it in their grant. A member who is offline meanwhile gets it the
  next time it links to any member (or the owner's pairing code); until then it cannot use
  the brokers. A removed member keeps the old channel and learns nothing new from it.
  **Recovery:** the owner gets a recovery code (`knot-rk1-...`: room secret, creator id, a
  recovery key seed and the current rotation), shown once and never stored. Its public key is
  registered in the chain. On a new device, pasting the code reopens the room; as soon as a
  member shows the chain, the device signs a `recover` with that key and becomes owner, the
  lost identity is removed and the keys rotate. Removing a member, a transfer or a recovery
  makes older codes stop working, and the app makes a fresh one. The code is as sensitive as
  a password: whoever holds it can take the room over.
  Remaining gap: a removed member who copied the room secret can still read what members
  say on the brokers *before* they get the new secret, and sees who is online on the old
  channel until everyone has moved.
* **Old and new side by side:** rooms made before the owner update stay open rooms (no
  owner controls, `#r=` links); new rooms are owned (`#j=` links). They are independent, also
  after a reload. An owned room is open to new clients only: an older client has no way in,
  and in an open room it just does not see replies, deletions or membership messages. The
  owner id is also kept under its own key (`owner:<room>`) so an older version, or another
  tab, rewriting the room list cannot turn an owned room into an open one; the room list is
  merged on save, so tabs do not drop each other's rooms. If an owned room was already
  saved without its owner, the creating device recognises its own signature on the chain
  and takes it back; other members cannot, and rejoin through the owner.
* **Room names:** "New room" opens a dialog (name, Create or Cancel): nothing exists until
  Create is pressed, and a double click makes one room. The default name is the first free
  "Room N". The ✎ button renames a room; names are local to each device. The room list is
  saved one write at a time, so rooms created together are all kept.
* **Membership notices:** admissions, removals, hand-overs and recoveries appear in the
  conversation as one quiet line ("Bob joined"); recovery keys never do.
* **Attachments:** pasted, dropped and picked files wait in the message box (chips with a
  preview and a remove button) and are sent, to everyone, only with Enter or Send: files
  first, then the text. The message box grows with its text up to a cap.
* **Calls:** audio and video for up to `callMaxParticipants` (6) people, in a mesh: everyone
  in the call holds one media connection to everyone else, so there is no media server (and
  no per-person cost beyond bandwidth: video bitrate per stream shrinks as people join).
  Who is in the call, and the SDP of each media connection, travel as `{t:'call'}` frames
  over the room's authenticated direct chat links, never over the brokers and never in the
  message log. Only members (peers the room has accepted) can send them, and each media
  connection's DTLS fingerprint rides inside that authenticated channel, so a call is tied
  to a known identity. Each pair has one connection with two fixed transceivers (audio,
  video); the peer with the smaller id always offers. Muting is `track.enabled`, the camera
  is `replaceTrack` (off stops the capture, so the light goes out): neither renegotiates.
  A connection that dies is offered again with growing pauses. Camera and microphone are
  asked for only when you join (or turn the camera on); a refused device still lets you
  listen. One call at a time per device; it keeps running while you read another room
  ("minimize"). Needs HTTPS or localhost. Without a TURN server (Settings) two people
  behind strict NATs cannot connect, same as chat.
* **Version and language:** the version (`src/version.js`, kept equal to `package.json` by a
  test; bump both for a release) sits next to the title in the room list. Settings >
  Language picks Automatic (the browser's), English, 中文 or Deutsch; the choice is stored
  with the other settings and redraws everything on screen at once (a running call goes on).
  To add a language: a dictionary and a `LANGUAGES` entry in `ui/i18n.js`; a test fails while
  any text is missing or its `{placeholders}` differ.
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
