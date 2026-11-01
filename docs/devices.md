# Devices and tabs

One identity on several devices: linking, shared state, the private channel between our devices,
and the one-tab rule.

[Back to the README](../README.md)

## Linked devices

The identity key cannot leave its device, so a second device keeps its own key and gets a
*certificate* from the main one (`{r: main key, d: device key, n: name, ms, sig}`, signed by the
main key). The linked device writes as the main identity: its envelopes carry the certificate and
the id of the main identity, and `verifyEnvelope` accepts that only if the certificate is genuine
and names exactly the key that signed. On every new link the device first sends the certificate
(`{t:'cert'}`); it must name the key the link was authenticated with, and then the link counts as
the main identity's (so an owned room admits it without admitting the device key).

### Linking

A linked device acts as the main identity in everything: it creates rooms (owned by the identity),
answers join requests (grants and denials carry the certificate, and the owner lobby is addressed
by the identity, so all its devices answer) and makes membership changes and `unlink`s, which
rooms check against the identity (the owner). Only a `recover` is signed by a key of its own, and
only the main device can link a new device (it holds the key that signs certificates). Its
counters start at 500000, so it cannot make the same envelope id as the main device in one
millisecond.

Linking is two codes (QR or pasted text), no server: the new device shows a *request* (its key, a
one-time sealing key, a name, signed with its key); the main device answers with a *grant* (the
certificate and every room's secret, owner id and key epoch, sealed to that one-time key, signed
by the main key). Both screens show six digits derived from all keys; if they differ, a code was
swapped. The one-time key of a request lives in memory only: after a reload the new device asks
again and the main device keeps one entry for it. The grant is stored with the certificate in one
write and finished at every start until done, so a reload in the middle leaves either no link or a
complete one.

A device is never linked to itself (another tab of the same browser profile): the main device
refuses a code made by itself, a device refuses a grant from itself, and a certificate of a key
for itself (an old mistake that left the main device unable to link anything) is dropped at start.
Rooms joined later reach the other devices by themselves (see *Shared state* below).

### Unlink and separate

*Unlink* (any device, for any linked device but itself; the main device cannot be unlinked;
Settings > Linked devices) is a signed `unlink` envelope in every room, kept forever like
membership changes: peers drop that device's links and refuse everything it writes with that
certificate, including history that arrives later; the device itself notices and goes back to its
own identity. The unlinked device is told first (through our channel, if no room reaches it), then
dropped from the channel. A linked device can also *separate* itself (Settings > Linked devices):
it withdraws itself the same way.

A withdrawn or separated device restarts with a **new key** (the old one stays withdrawn in the
rooms that saw the unlink, so it could never be linked to the same main device again) and keeps
the history of its rooms; it is a device of its own again and can link others.

**Limits.** A stolen linked device can read and write as you, and unlink your other linked
devices, until the main device unlinks it; unlinking does not change room keys (an owner removing
a member does, see [Security](security.md#owner-and-membership)); each device keeps its own call
connections.

### Names and the connection bar

Every device of one identity shows that identity's messages as its own ("You", edit, delete). Once
a certificate or alias of someone has been seen (in a message or on a link), their name carries a
device tag in messages, calls, exports and the connection bar, always written `name @ device` (a
person at a device, as in user@host; `AT` in `ui/alias.js` is the one place for it): `Ada @ phone`
or `Ada @ main`. Someone with one device has no tag. Presence carries the certificate and alias
too, so devices that are only seen on a broker are grouped and tagged as well.

The connection bar has one entry per person, each device with its connection type in brackets and
in the colour of that type: `Bob (direct)`, `Ada @ main (direct) | mac (relay)`. The types, as
seen from this device (the `?` in the bar explains them to the user): **direct**, a direct link
between the two devices, no server in between; **relay**, no direct link, messages go on through
the brokers; **seen**, in the room but not linked yet; **connecting**, a link is being set up;
**offline** (only for ourselves).

We are in the bar too, first, always as **You** and in a colour of our own (purple), and our
connection type is the best way this device reaches the room: direct if it has at least one direct
link, relay if it only reaches a broker, offline if neither: `You (direct)`, `You (relay)`,
`You (offline)`, and with linked devices
`You @ main (this device, direct) | mac (direct) | pixel (relay)`.

The hold-V details line reads the same way
(`Bob (direct, through NAT): host ↔ srflx, UDP, 23 ms, paired by code`, `Ada @ phone (...)`, first
a line for this device with the brokers it reaches).

The tag is the device's *alias*: it starts as the name given when linking (suggested from the
device kind: iPhone, iPad, Android, Mac, Windows, Linux; numbered if taken; the main device is
"main") and can be changed in Settings > Linked devices on any device, for any device. A message
carries it as `al` `{ n, sig }`, signed with the writing device's key over the message id (so it
cannot be moved to another message); old versions ignore the field.

### Shared state

The settings except notifications (name, language, STUN/TURN, brokers, relay, previews), the
aliases, the *room list* and the *read marks* are last-writer-wins registers (hybrid clock stamp,
device id as tie-break), kept under `sync`. A change is sent as `{t:'sync', items}` over the
direct links to our other devices (a link proves that with the main id or the certificate) in
every room, relayed on, and each device sends all it has when a link to one of its devices comes
up, so changes made while apart arrive when two devices meet in any room. The newest change wins
everywhere. Received items are checked (known keys, value types and sizes) before use.

At the first link the new device *adopts* the main device's state (the grant carries it) instead
of merging it with its own, so the main device's settings and name win even over newer ones the
new device made before.

Rooms: `r:<room id>` holds the secret, label and owner id, or null once the room was left (a
tombstone, so it does not come back from a device that still has it); a device opens rooms it gets
(with their key epoch, sent along), renames, and leaves rooms as the item says, and checks that
the secret is that room's. A room this identity owns is never dropped from another device (the
owner role cannot be recovered); leaving it elsewhere only affects that device.

Read marks: `k:<room id>` holds the newest message stamp read on any device and only moves
forward, so a room read on one device is not unread on the others. Rooms and marks are recorded
only while there are other devices (linking records the ones that exist), and a leave is announced
before the links close.

## Our devices' channel

Devices that share no room (a new device, a main device without rooms) still find each other:
`c:devices` holds the secret of a room that only they know. It is opened like any room (brokers,
WebRTC) but is not in the room list and keeps nothing on disk, and only our own devices (the main
id, or a valid certificate for it) count there. The main device makes the secret when it first has
another device; it reaches the others in the grant and later in the shared state. It does not
change when a device is unlinked: the unlinked device is refused (a `d:` record, see above)
wherever that is known, which a device that was offline then learns from the other devices when it
connects.

## One tab per browser profile

The tabs of a profile share one identity and database, and two running at once would clash (same
peer id, room list overwritten, equal message stamps). The first tab takes a Web Lock; others show
a message instead of starting (taken before the identity is read, so a first run in two tabs
cannot make two). Another person on the same device needs another browser profile or a private
window. Without Web Locks nothing is enforced.
