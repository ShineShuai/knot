# Architecture

How the code is laid out. Behaviour and protocol details are in the topic documents listed in the
[README](../README.md#documentation).

## Layers

| Directory | Role |
|---|---|
| `net/` | links between peers: WebRTC data channels, the MQTT brokers, handshakes, ICE |
| `crypto/` | identity key, signatures, room keys, sealed boxes, linked-device certificates |
| `chat/` | room logic: message log, membership, owner functions, pairing, device linking |
| `files/` | file transfer and image preview derivation and cache |
| `call/` | audio/video calls and their quality control |
| `store/` | persistence: key-value stores, persistent-storage request, one-tab lock |
| `ui/` | DOM views, dialogs, i18n; text is always inserted as text, never as HTML |
| `util/`, `qr/`, `vendor/` | byte helpers, clock, rate limiter; QR encoder; TweetNaCl fallback |

## Module map

    src/
      main.js                boot
      app.js                 AppModel: identity, settings, set of rooms
      config.js              defaults: STUN, brokers, limits (overridable in Settings)
      version.js             the version shown in the room list (equal to package.json)
      build.js               which deploy this is: channel (beta/prod) and commit, from the page
      update.js              notices a newer published build (build.json)
      util/
        bytes.js             base64url, concat, hashing, binary writer/reader
        emitter.js           minimal event emitter
        hlc.js               hybrid logical clock
        rate.js              token-bucket rate limiter
      crypto/
        identity.js          Ed25519 device key (non-extractable, IndexedDB)
        curves.js            WebCrypto or TweetNaCl for Ed25519 / X25519 (feature-probed)
        soft-key.js          seed encrypted at rest, for devices on the TweetNaCl path
        box.js               sealed box to an X25519 key (ephemeral ECDH, HKDF, AES-GCM)
        room-keys.js         room secret -> HKDF -> topic id + AES-GCM key
        delegation.js        certificates of linked devices
      vendor/nacl-fast.js    TweetNaCl 0.14.5, public domain; fetched only without WebCrypto curves
      net/
        sdp.js               SDP <-> compact SdpInfo (data-channel-only)
        handshake.js         signed offer/answer, ~300-char code, short auth string
        peer-link.js         one RTCPeerConnection: "chat" + "files" channels
        mqtt.js              minimal MQTT 3.1.1 client over WebSocket
        room-channel.js      presence, signaling, text relay over brokers (sealed)
        broker-health.js     which brokers answer and how fast; probed at startup
        ice-probe.js         STUN ranking, NAT type probe
        ice-gather.js        wait for ICE candidates (shared by data and call connections)
      chat/
        room.js              Room: ties links, brokers and log together; delegates to the ones below
        envelope.js          signed chat message format + verification
        log.js               ordered, de-duplicated, capped message log + sync delta
        message-store.js     persists a room's messages, one record per message
        roster.js            who belongs to the room: the owner's chain of admit / revoke / transfer
        lobby.js             how someone with a join link asks the owner to let them in
        join.js              a pending request to join an owner-run room
        owner-desk.js        the owner's part: join requests, lobby, removal, recovery, transfer
        recovery.js          the owner's recovery code (knot-rk1-...)
        pairing.js           connecting two devices: codes by hand, or offers through the brokers
        room-files.js        share a file, fetch one, get an image preview from any peer
        read-marks.js        what this device has shown its user: the unread count
        notice.js            one-line text for membership changes ("Bob joined")
        search.js            search the messages this device holds
        devices.js           linking a device: request and grant codes, six-digit check
        device-sync.js       settings and aliases shared by our devices: newest change wins
      files/
        transfer.js          chunked P2P file transfer with SHA-256 check
        image.js             image sniffing, sender-side thumbnail/preview derivation
        preview-cache.js     per-room LRU cache of previews (IndexedDB)
      store/
        kv.js                async key-value stores: IndexedDB in the browser, a Map in tests
        persist.js           asks the browser not to delete our storage
        instance-lock.js     one running tab per browser profile (Web Locks)
      call/
        call.js              CallManager: mesh call of one room, presence + signaling frames
        call-link.js         one audio+video RTCPeerConnection to one participant
        quality.js           video quality policy: ladder, ceilings, stats reader, controller,
                             QualityGroup (the connections of a call take turns)
        media.js             microphone / camera / screen access (swappable in tests)
        speaking.js          who is speaking: loudness per stream, with a short hold time
      qr/qr.js               QR encoder (verified against OpenCV in tests)
      ui/
        view.js              the page: room list, the open room, unread, updates
        composer.js          the message box: text, replies, edits, staged files, drop, paste
        attach.js            paste and drag & drop helpers (no DOM access)
        messages.js          one message: links, reactions with their palette, files, notices
        linkify.js           http(s) links in message text
        emoji.js             the emoji offered for reactions
        image-card.js        one image in the log: thumbnail, preview, original
        image-cards.js       the image cards of the open room, the lightbox
        alias.js             a name with its device tag ("Ada @ phone"), the bar entries
        conn.js              text for the hold-V connection reveal
        reveal.js            hold V: how everyone is connected
        dialog-kit.js        the dialog frame and its footer, copy field, QR, code box with scanner
        room-dialogs.js      new, rename, recovery code, invite, members, export, leave
        join-dialogs.js      joining: by link, code, recovery code, or asking the owner
        settings-dialogs.js  settings, linked devices, diagnostics
        call-view.js         the call window: tiles, microphone / camera / chat / leave
        scanner.js           camera QR scanning (BarcodeDetector), paste fallback
        notifier.js          browser notifications for rooms that are not on screen
        export.js            history as text or signed JSON
        diagnostics.js       browser feature checks and recent errors, as copyable text
        i18n.js              dictionaries (en/zh/de) and the language choice
        dom.js               DOM helpers
    sw.js                    service worker: offline shell, notification clicks
    lab/                     network lab page (STUN, NAT, brokers, a real pairing)
    test/                    unit tests (+ fakes) and real-browser e2e (see testing.md)
    tools/                   dev server, deploy assembly, release gate, network shaping
    deploy/                  Cloudflare config (headers, wrangler)

## Glare

The peer with the smaller id always makes the offer.
