# knot - serverless peer-to-peer chat room

Browser-only chat: WebRTC data channels between devices, no application server,
no build step, no dependencies (one vendored fallback, see below). Messages are signed, rooms are end-to-end sealed
wherever a third party is involved, and the app still works when public
signaling brokers are blocked (manual QR / text pairing).

## Run

    node tools/serve.mjs 8080        # then open http://localhost:8080
    npm test                         # unit tests (Node 22+)
    npm install --no-save playwright && npx playwright install   # once, for the browser tests
    npm run test:e2e                 # Chromium: the full suite (fake camera and microphone)
    npm run test:e2e:all             # that, then the engine suite in Firefox and WebKit (Safari's), as installed
    npm run test:e2e:webkit          # one browser's engine suite; or :firefox

Playwright is found in this project, the global npm folder or the cache of `npx`;
`PLAYWRIGHT_MODULE=/full/path/to/playwright` overrides that (a real path, not a placeholder).

The browser tests have two suites (`test/e2e/browsers.mjs`). *Full* (Chromium only, which has a
fake camera and microphone): real WebRTC between two pages, calls, layout. *Engine* (any
browser): the checks of a single page, namely the UI, two rooms paired inside one page (text,
edit, reaction, image thumbnail and preview, original, delete) and the lab page. `E2E_SUITE`
overrides the default (full in Chromium, engine elsewhere).

CI (`.github/workflows/ci.yml`): unit tests and the browser tests run on every push and pull
request: the full suite in Chromium, the engine suite in Firefox and WebKit. Only Chromium blocks
a deploy for now (`continue-on-error` on the others, see the comment in the file); a push to
`main` whose unit tests and Chromium tests pass is published to GitHub Pages (one-time:
Settings > Pages > Source: GitHub Actions).

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
      crypto/curves.js     WebCrypto or TweetNaCl for Ed25519 / X25519 (feature-probed)
      crypto/soft-key.js   seed encrypted at rest, for devices on the TweetNaCl path
      vendor/nacl-fast.js  TweetNaCl 0.14.5, public domain; fetched only without WebCrypto curves
      crypto/room-keys.js  room secret -> HKDF -> topic id + AES-GCM key
      crypto/delegation.js certificates of linked devices
      net/sdp.js           SDP <-> compact SdpInfo (data-channel-only)
      net/handshake.js     signed offer/answer, ~300-char code, short auth string
      net/peer-link.js     one RTCPeerConnection: "chat" + "files" channels
      net/mqtt.js          minimal MQTT 3.1.1 client over WebSocket
      net/room-channel.js  presence, signaling, text relay over brokers (sealed)
      net/ice-probe.js     STUN ranking, NAT type probe
      net/broker-health.js which brokers answer and how fast; probed at startup
      net/ice-gather.js    wait for ICE candidates (shared by data and call connections)
      chat/envelope.js     signed chat message format + verification
      chat/log.js          ordered, de-duplicated, capped message log + sync delta
      chat/room.js         Room: ties links, brokers, log together and delegates to the four below
      chat/room-files.js   share a file, fetch one, get an image preview from any peer
      chat/owner-desk.js   the owner's part: join requests, lobby, removal, recovery, transfer
      chat/pairing.js      connecting two devices: codes by hand, or offers through the brokers
      chat/read-marks.js   what this device has shown its user: the unread count
      chat/notice.js       one-line text for membership changes ("Bob joined")
      chat/devices.js      linking a device: request and grant codes, six-digit check
      chat/device-sync.js  settings and aliases shared by our devices: newest change wins
      chat/search.js       search the messages this device holds
      files/transfer.js    chunked P2P file transfer with SHA-256 check
      files/image.js       image sniffing, sender-side thumbnail/preview derivation
      files/preview-cache.js  per-room LRU cache of previews (IndexedDB)
      store/persist.js     asks the browser not to delete our storage
      store/instance-lock.js  one running tab per browser profile (Web Locks)
      call/call.js         CallManager: mesh call of one room, presence + signaling frames
      call/call-link.js    one audio+video RTCPeerConnection to one participant
      call/quality.js      video quality policy: ladder, ceilings, stats reader, controller,
                           QualityGroup (the connections of a call take turns)
      call/media.js        microphone / camera / screen access (swappable in tests)
      qr/qr.js             QR encoder (verified against OpenCV in tests)
      ui/                  DOM helpers, i18n (en/zh/de), views, camera scanner
      ui/view.js           the page: room list, the open room, unread, updates
      ui/composer.js       the message box: text, replies, edits, staged files, drop, paste
      ui/messages.js       one message: links, reactions with their palette, files, notices
      ui/alias.js          a name with its device tag: "Ada · phone"
      ui/image-cards.js    the image cards of the open room, the lightbox
      ui/dialog-kit.js     the dialog frame, copy field, QR, code box with scanner
      ui/room-dialogs.js   new, rename, recovery code, invite, members, export, leave
      ui/join-dialogs.js   joining: by link, code, recovery code, or asking the owner
      ui/settings-dialogs.js  settings, linked devices, diagnostics
      ui/reveal.js         hold V: how everyone is connected
      ui/image-card.js     one image in the log: thumbnail, preview, original
      ui/call-view.js      the call window: tiles, microphone / camera / chat / leave
      call/speaking.js     who is speaking: loudness per stream, with a short hold time
      ui/linkify.js        http(s) links in message text
      ui/emoji.js          the emoji offered for reactions
      ui/notifier.js       browser notifications for rooms that are not on screen
      ui/export.js         history as text or signed JSON
      ui/diagnostics.js    browser feature checks and recent errors, as copyable text
      update.js            notices a newer published build (build.json)
    lab/                   network lab page
    test/                  unit tests (+ fakes) and real-browser e2e (full suite: Chromium; engine suite: also Firefox, WebKit)

## Design notes

* **Old browsers (LEGACY-CURVES):** WebCrypto got Ed25519 and X25519 in Safari 17 / iOS 17,
  Firefox 129 and Chrome 137 (every iOS browser is WebKit, so iOS 16 has neither). Without them
  the app signs, verifies and seals with the bundled TweetNaCl: same formats, so old and new
  devices talk to each other. The library (14 KB gzipped, same origin like every module) is
  fetched at start-up only by a browser that needs it, and kept by the service worker. Costs: slower (tens of ms
  per signature on an old iPad), and the identity is a seed that lives in page memory and,
  encrypted with a non-extractable AES key (WebKit keeps that key wrapped in the Keychain), in
  IndexedDB: a copy of the storage is useless, but code running in the page can read it (the
  CSP keeps foreign code out). When the browser later gains the curves, the key moves into
  WebCrypto as non-extractable. `npm run test:soft` runs the unit tests in this mode;
  Settings > Diagnostics shows which is used. It is to be removed one day: the review date and
  the steps are in `src/config.js` (`LEGACY_CURVES_REVIEW_BY`), and a unit test fails after
  that date so it is not forgotten.
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
  no per-person cost beyond bandwidth: video quality per stream shrinks as people join).
  Who is in the call, and the SDP of each media connection, travel as `{t:'call'}` frames
  over the room's authenticated direct chat links, never over the brokers and never in the
  message log. Only members (peers the room has accepted) can send them, and each media
  connection's DTLS fingerprint rides inside that authenticated channel, so a call is tied
  to a known identity. Each pair has one connection with two fixed transceivers (audio,
  video); the peer with the smaller id always offers. Muting is `track.enabled`, the camera
  is `replaceTrack` (off stops the capture, so the light goes out): neither renegotiates.
  A connection that dies is offered again with growing pauses. Camera and microphone are
  asked for only when you join (or turn the camera on); a refused device still lets you
  listen. **Video quality** favours audio first, then smooth motion (no queueing, so no added
  delay), then sharpness. The camera is captured at up to 720p/30; each connection encodes
  only what it can carry and the receiver shows (`call/quality.js`, no renegotiation, only
  `setParameters`): a ladder of rungs (180p/15 fps/100 kb/s up to 720p/30/1.8 Mb/s; a screen
  share has its own, sharper and slower) capped by the head count, by the receiver's tile
  (`want` frames: tile height in pixels, 0 for a hidden tile or a page out of sight for 5 s)
  and by what the connection proved (`getStats` every 2 s: loss, round-trip time, the
  browser's own limit/estimate where it reports them). Down is fast (two bad samples, or one
  severe: two rungs), up is slow (one rung after 8 s calm, longer after a failed try). If even
  the lowest rung does not fit, video pauses for that peer (their tile says so), audio goes
  on, and video is tried again after a pause. Cameras degrade by resolution first, screens by
  frame rate (`degradationPreference`, where the browser has it). The connections of a call
  share one uplink, so they take turns: one steps down per review, one climbs at a time, and
  only while none suffers (severe trouble acts at once). A rung that failed is not tried
  again blindly for 45-180 s, so the picture does not jump up and down; where the browser
  does not say why it holds back (Firefox, Safari), frames smaller than asked for are the
  sign. Settings > Diagnostics lists every call connection (rung, bitrate, frame size and
  rate, loss, round-trip time, the browser's limit and estimate, what each side asked for,
  what we receive). One call at a time per device; it keeps running while you read another room
  ("minimize"). Texting and files work during a call: the chat button (💬) puts the room's
  conversation next to the video (call at the side on a desktop, on top on a phone) with the
  usual message box, drop, paste and reactions, and counts what arrives while the call covers
  the conversation; "minimize" leaves a bar *below* the conversation, so the message box stays
  free. Files use their own data channel, so a transfer shares bandwidth with the call but needs
  no extra connection. The call bar has a file toggle (📎): paused, this device neither shares,
  serves nor fetches files and waits with image previews (thumbnails and text are not affected;
  a peer asking gets "paused during a call"); it is local to the device and ends with the call.
  Everyone in the call is always shown, camera or not: a person without video gets an avatar,
  the grid divides its space by head count (nobody scrolls out of view, also beside the chat
  or above it on a phone), and the minimized bar names everyone (🔇: muted, …: connecting).
  The person who is speaking gets an outline on their tile (and 🔊 in the minimized bar):
  each audio stream is measured in the browser (Web Audio analyser, nothing is played or
  recorded), above a small loudness threshold and held for 0.4 s so it does not flicker; our
  own microphone counts too, a muted one is silent. Browsers without Web Audio just show no
  highlight.
  Call signalling travels on direct links only, so someone without a direct link to you cannot
  be listed.
  Desktop browsers can share a screen, window or tab instead of the camera (the
  tile shows it whole, not cropped; the browser's own "stop sharing" button ends it); phones
  have no screen capture, so they only get the camera. Needs HTTPS or localhost. Without a TURN server (Settings) two people
  behind strict NATs cannot connect, same as chat.
* **Version and language:** the version (`src/version.js`, kept equal to `package.json` by a
  test; bump both for a release) sits next to the title in the room list. Settings >
  Language picks Automatic (the browser's), English, 中文 or Deutsch; the choice is stored
  with the other settings and redraws everything on screen at once (a running call goes on).
  To add a language: a dictionary and a `LANGUAGES` entry in `ui/i18n.js`; a test fails while
  any text is missing or its `{placeholders}` differ.
* **Reactions and edits:** two more signed envelope kinds that ride on another message.
  `react` {id, emoji, on}: per author, message and emoji only the latest counts, so toggling
  never piles up (one envelope per slot; the "off" one stays so an older "on" cannot return).
  `edit` {id, text}: only the message's author may send it (checked on receipt, not only in the
  UI); the latest wins and replaces older edits. The signed original is never changed, so the
  original text stays in the log and in the JSON export: an edit corrects a typo, delete removes
  content. Deleting a message also drops its edits and reactions, and later ones are refused.
  Reactions must be one emoji (checked on receipt). Both travel and sync like messages and
  count against the log cap. The palette shows a quick row of six; "＋" opens about sixty more
  and a box for any other emoji (typed or pasted from the keyboard's emoji picker; anything
  `isEmoji` refuses is ignored). A person may react with as many different emoji as they like.
* **Broker health:** at startup every configured broker is probed (WebSocket and MQTT
  CONNACK, with its time), like STUN. Channels connect to the fast ones first; a broker whose
  probe failed is left alone (a retry only every minute or so, at once if a real connection
  works) and probed again every five minutes. Settings shows each broker with its time or
  "not reachable", with a *Check brokers* button.
* **Keeping your data:** the page asks the browser for persistent storage
  (`navigator.storage.persist()`) at the first click; Settings says whether it was granted and
  can ask again. Without it the browser may delete the identity key and history when space is
  low (Safari: after about a week without a visit unless the app is installed to the Home
  Screen or Dock). The key cannot be recovered.
* **Call quality tests:** `test/quality-sim.js` models one sender's uplink (a bandwidth
  estimate that follows the capacity with a lag, a queue, then loss) and `quality-sim.test.js`
  runs the controller through it for browsers that report nothing extra, a limit reason, or a
  bandwidth estimate: a rich link, 600 kb/s, a collapse and a recovery, a hopeless link, five
  connections on 1 Mb/s. It checks the behaviour (settles, does not flap, short queue, video
  returns), not a real network: for that, `sudo tools/netshape.sh weak|lte|lossy|hopeless|cycle`
  shapes this Mac's UDP traffic (macOS, dummynet + pf; `off` restores) while you call from
  another device, and Settings > Diagnostics shows what the call did. Check Chrome, Firefox
  and Safari with 2, 4 and 6 people.
* **Diagnostics:** Settings > Diagnostics makes a text report for when something works in one
  browser and not in another: the browser, what it supports (WebRTC, Ed25519 and X25519,
  image encoding, IndexedDB buffers...), every room's links (direct, relayed), the brokers and
  the last errors the page hit. It holds no messages or keys. A JPEG thumbnail (the only
  format Safari encodes) may be up to 9 KB; a failing OffscreenCanvas falls back to a page
  canvas.
* **Links:** `http://` and `https://` addresses in message text become links that open in a new
  tab with `noopener noreferrer`. Only plain-ASCII addresses with a dotted host (or `localhost`)
  are linked, never ones with a user name or password (`https://bank.com@evil.test`), other
  schemes (`javascript:`, `data:`), or addresses over 2000 characters; so look-alike letters and
  hidden direction marks cannot pass for a known site. Trailing punctuation and unmatched
  closing brackets stay outside the link. The text itself is never changed (and signed as typed);
  hovering a link shows the address it really goes to. Quotes and notifications show plain text.
* **Unread and notifications:** each device keeps, per room, the stamp of the newest message it
  has shown (`read:<room>` in storage; on first run everything already there counts as read).
  Messages from others after that stamp are "unread": counted in the room list, in the tab
  title `(3) knot` and on an installed app's icon. A room on screen (page visible and focused)
  is read at once. Settings > "Notify me about new messages..." asks the browser for permission
  (from the click) and then shows one notification per room, with several arrivals summed up.
  Notifications go through the service worker when there is one (phones need that; clicking
  opens the room). There is no push server, so they only work while the app is open somewhere.
* **Search and export:** the search box (🔍) filters the conversation to messages whose
  current text or file name contains every word (case and accents ignored); it covers what
  this device holds (the log, up to `logCap`). Export (⤓) saves that same history as readable
  text or as the signed envelopes (JSON, verifiable); shared files are not included.
* **Updates:** the deploy stamps the commit into `index.html` (`<meta name="build">`) and writes
  `build.json` ({"build": "<commit>"}). The page compares the two every 15 minutes and when you
  return to the tab (at most once a minute); when they differ, a bar offers "Reload" (and asks
  first during a call). A static page cannot update itself. Without the stamp (local
  development, tests) nothing happens, not even a request.
* **Linked devices (same identity on a second device):** the identity key cannot leave its
  device, so a second device keeps its own key and gets a *certificate* from the main one
  (`{r: main key, d: device key, n: name, ms, sig}`, signed by the main key). The linked device
  writes as the main identity: its envelopes carry the certificate and the id of the main
  identity, and `verifyEnvelope` accepts that only if the certificate is genuine and names
  exactly the key that signed. On every new link the device first sends the certificate
  (`{t:'cert'}`); it must name the key the link was authenticated with, and then the link counts
  as the main identity's (so an owned room admits it without admitting the device key).
  A linked device acts as the main identity in everything: it creates rooms (owned by the
  identity), answers join requests (grants and denials carry the certificate, and the owner
  lobby is addressed by the identity, so all its devices answer) and makes membership changes
  and `unlink`s, which rooms check against the identity (the owner). Only a `recover` is signed
  by a key of its own, and only the main device can link a new device (it holds the key that
  signs certificates). Its counters
  start at 500000, so it cannot make the same envelope id as the main device in one
  millisecond. Linking is two codes (QR or pasted text), no server: the new device shows a
  *request* (its key, a one-time sealing key, a name, signed with its key); the main device
  answers with a *grant* (the certificate and every room's secret, owner id and key epoch,
  sealed to that one-time key, signed by the main key). Both screens show six digits derived
  from all keys; if they differ, a code was swapped. The one-time key of a request lives in memory only: after a
  reload the new device asks again and the main device keeps one entry for it. The grant is
  stored with the certificate in one write and finished at every start until done, so a reload
  in the middle leaves either no link or a complete one. A device is never linked to itself
  (another tab of the same browser profile): the main device refuses a code made by itself, a device
  refuses a grant from itself, and a certificate of a key for itself (an old mistake that left
  the main device unable to link anything) is dropped at start. Rooms joined later reach the
  other devices by themselves (see *Shared state* below). *Unlink* (any device, for any linked device but itself; the main device cannot
  be unlinked; Settings > Linked devices) is a signed `unlink` envelope in every room, kept
  forever like membership changes: peers drop that device's links and refuse everything it
  writes with that certificate, including history that arrives later; the device itself
  notices and goes back to its own identity. The unlinked device is told first (through our channel, if no
  room reaches it), then dropped from the channel. A linked device can also *separate* itself
  (Settings > Linked devices): it withdraws itself the same way. A withdrawn or separated
  device restarts with a **new key** (the old one stays withdrawn in the rooms that saw the
  unlink, so it could never be linked to the same main device again) and keeps the history
  of its rooms; it is a device of its own again and can link others. Limits: a stolen linked device can read and write as you, and
  unlink your other linked devices, until the main device unlinks it; unlinking does not
  change room keys (an owner removing a member does, see above); each device keeps its own
  call connections. Every device
  of one identity shows that identity's messages as its own ("You", edit, delete). Once a
  certificate or alias of someone has been seen (in a message or on a link), their name
  carries a device tag in messages, calls and exports: "Ada · phone" or
  "Ada · main". Someone with one device has no tag. Presence carries the certificate and alias too, so
  devices that are only seen on a broker are grouped and tagged as well. The connection bar has one entry per person, with
  their devices and connections: "Bob · direct", "Ada · main direct | mac relay". The tag is the device's *alias*: it starts
  as the name given when linking (suggested from the device kind: iPhone, iPad, Android, Mac,
  Windows, Linux; numbered if taken; the main device is "main") and can be changed in
  Settings > Linked devices on any device, for any device. A message carries it as `al`
  `{ n, sig }`, signed with the writing device's key over the message id (so it cannot be moved
  to another message); old versions ignore the field. **Shared state:** the settings except
  notifications (name, language, STUN/TURN, brokers, relay, previews), the aliases, the *room
  list* and the *read marks* are last-writer-wins registers (hybrid clock stamp, device id as tie-break), kept under `sync`.
  A change is sent as `{t:'sync', items}` over the direct links to our other devices (a link
  proves that with the main id or the certificate) in every room, relayed on, and each device
  sends all it has when a link to one of its devices comes up, so changes made while apart
  arrive when two devices meet in any room. The newest change wins everywhere. Received items
  are checked (known keys, value types and sizes) before use. At the first link the new
  device *adopts* the main device's state (the grant carries it) instead of merging it with its
  own, so the main device's settings and name win even over newer ones the new device made
  before. Rooms: `r:<room id>` holds the
  secret, label and owner id, or null once the room was left (a tombstone, so it does not come
  back from a device that still has it); a device opens rooms it gets (with their key epoch,
  sent along), renames, and leaves rooms as the item says, and checks that the secret is that
  room's. A room this identity owns is never dropped from another device (the owner role
  cannot be recovered); leaving it elsewhere only affects that device. Read marks: `k:<room id>`
  holds the newest message stamp read on any device and only moves forward, so a room read on
  one device is not unread on the others. Rooms and marks are recorded only while there are
  other devices (linking records the ones that exist), and a leave is announced before the
  links close.
* **Our devices' channel:** devices that share no room (a new device, a main device without
  rooms) still find each other: `c:devices` holds the secret of a room that only they know. It
  is opened like any room (brokers, WebRTC) but is not in the room list and keeps nothing on
  disk, and only our own devices (the main id, or a valid certificate for it) count there. The
  main device makes the secret when it first has another device; it reaches the others in the
  grant and later in the shared state. It does not change when a device is unlinked: the
  unlinked device is refused (a `d:` record, see above) wherever that is known, which a device
  that was offline then learns from the other devices when it connects.
* **One tab per browser profile:** the tabs of a profile share one identity and database, and
  two running at once would clash (same peer id, room list overwritten, equal message stamps).
  The first tab takes a Web Lock; others show a message instead of starting (taken before the
  identity is read, so a first run in two tabs cannot make two). Another person on the same
  device needs another browser profile or a private window. Without Web Locks nothing is
  enforced.
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
  pairing codes (10 min TTL, single use), `wss://` only for brokers. The CSP forbids inline
  styles, so an image card gets its size from the `width` and `height` attributes of its
  image rather than from `style`. (The QR scanner's `<video>` is only made when scanning
  starts. The CSP lines that Playwright's WebKit prints come from its own Web Inspector script,
  `web-inspector://...`: the browser tests ignore those and nothing else.)
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
* Verified: unit tests; the full browser suite in Chromium and the engine suite in Firefox (CI)
  and WebKit (CI on Linux, Playwright's WebKit 27.2 on macOS). Playwright's Firefox does not
  start on one macOS machine (Node 26.10: "Could not find profile folder", also after a forced
  reinstall); `npm run test:e2e:all` skips it. Not verified: real public brokers, phones,
  mainland China networks. Safari: image previews and message deletion were reported failing on
  some macOS/Safari versions and working on others (maybe version-related, not investigated
  further); Settings > Diagnostics shows what a given Safari supports.
