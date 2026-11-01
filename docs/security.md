# Security

Identity, room ownership and membership, key rotation and recovery, and the hardening that applies
everywhere.

[Back to the README](../README.md)

## Identity

Each device has an Ed25519 key; peer id = first 8 bytes of SHA-256(public key). Handshakes are
signed, so the identity vouches for the DTLS fingerprint. Chat messages are signed and carry their
author; any peer or relay path can deliver them and anyone can verify them.

## Owner and membership

A room made now has an owner (its creator) who admits everyone. Members are a chain of
owner-signed envelopes (`admit`, `revoke`, `transfer`, each naming the previous one in `prev`, so
clocks do not matter and a removed owner cannot backdate).

A link carries only a *lobby* secret (derived one-way from the room secret, bound to the owner's
id): it reaches the owner, it cannot read the room. The joiner sends a signed greeting plus a
one-time X25519 key; the owner answers with the room secret sealed to that key and signed. Pairing
by an owner-made code counts as approval.

Peers talk chat only with identities in the chain (others are dropped after `adminTimeoutMs`), the
chain is never trimmed, and a removed identity is refused at once. The owner can also delete
anyone's message and hand the room to a member (`transfer`; old join links then stop working,
trust stays rooted in the creator's id). Rooms made before this update have no owner and stay open
to anyone with the link.

**Key rotation.** Removing a member also moves the room to new broker keys (topic, presence,
signalling, relay and join links all derive from the room secret mixed with a fresh per-removal
secret). The owner commits to that secret's hash in the removal envelope and hands the secret to
members over their authenticated P2P links; members pass it on, new joiners get it in their grant.
A member who is offline meanwhile gets it the next time it links to any member (or the owner's
pairing code); until then it cannot use the brokers. A removed member keeps the old channel and
learns nothing new from it.

**Recovery.** The owner gets a recovery code (`knot-rk1-...`: room secret, creator id, a recovery
key seed and the current rotation), shown once and never stored. Its public key is registered in
the chain. On a new device, pasting the code reopens the room; as soon as a member shows the
chain, the device signs a `recover` with that key and becomes owner, the lost identity is removed
and the keys rotate. Removing a member, a transfer or a recovery makes older codes stop working,
and the app makes a fresh one. The code is as sensitive as a password: whoever holds it can take
the room over.

**Remaining gap.** A removed member who copied the room secret can still read what members say on
the brokers *before* they get the new secret, and sees who is online on the old channel until
everyone has moved.

## Old and new side by side

Rooms made before the owner update stay open rooms (no owner controls, `#r=` links); new rooms are
owned (`#j=` links). They are independent, also after a reload. An owned room is open to new
clients only: an older client has no way in, and in an open room it just does not see replies,
deletions or membership messages. The owner id is also kept under its own key (`owner:<room>`) so
an older version, or another tab, rewriting the room list cannot turn an owned room into an open
one; the room list is merged on save, so tabs do not drop each other's rooms. If an owned room was
already saved without its owner, the creating device recognises its own signature on the chain and
takes it back; other members cannot, and rejoin through the owner.

## Hardening

CSP without inline code, all text via `textContent`, rate limit per link, size/shape validation of
every envelope, replay protection for pairing codes (10 min TTL, single use), `wss://` only for
brokers. The CSP forbids inline styles, so an image card gets its size from the `width` and
`height` attributes of its image rather than from `style`. (The QR scanner's `<video>` is only
made when scanning starts. The CSP lines that Playwright's WebKit prints come from its own Web
Inspector script, `web-inspector://...`: the browser tests ignore those and nothing else.)

## Old browsers (LEGACY-CURVES)

WebCrypto got Ed25519 and X25519 in Safari 17 / iOS 17, Firefox 129 and Chrome 137 (every iOS
browser is WebKit, so iOS 16 has neither). Without them the app signs, verifies and seals with the
bundled TweetNaCl: same formats, so old and new devices talk to each other. The library (14 KB
gzipped, same origin like every module) is fetched at start-up only by a browser that needs it,
and kept by the service worker. Costs: slower (tens of ms per signature on an old iPad), and the
identity is a seed that lives in page memory and, encrypted with a non-extractable AES key (WebKit
keeps that key wrapped in the Keychain), in IndexedDB: a copy of the storage is useless, but code
running in the page can read it (the CSP keeps foreign code out). When the browser later gains the
curves, the key moves into WebCrypto as non-extractable. `npm run test:soft` runs the unit tests
in this mode; Settings > Diagnostics shows which is used. It is to be removed one day: the review
date and the steps are in `src/config.js` (`LEGACY_CURVES_REVIEW_BY`), and a unit test fails after
that date so it is not forgotten.
