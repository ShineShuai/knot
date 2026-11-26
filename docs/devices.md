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
rooms check against the identity (the owner). A join request or an owner's pairing code answered by a linked device admits the main identity (the
request carries the certificate; the answer goes to the device key). Only a `recover` is signed by a key of its own, and
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
Settings > Devices) is a signed `unlink` envelope in every room, kept forever like
membership changes: peers drop that device's links and refuse what it writes with that
certificate **from the stamp of the unlink on**, including history that arrives later; what it
wrote before stays, even when it only arrives now. Which unlinks count depends only on the
unlinks a room holds, not on their arrival order: an unlink written by a device that was
already withdrawn by its stamp counts for nothing, and what a room refused or removed because
of such an unlink counts again once it is known to be void. After a restart (and in a room made
later) every room and the devices' channel refuse again each device whose `d:` item is null, from
the moment of the restart on: the channel keeps nothing, so nothing else remembers. The device
itself notices and goes back to its own identity. The unlinked device is told first (through our channel, if no room reaches it), then
dropped from the channel. A linked device can also *separate* itself (Settings > Devices):
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
"main") and can be changed in Settings > Devices on any device, for any device. A message
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

Room choices: `p:<room id>` holds the person's own choices for a room, `{ mute?: true, previews?:
'auto' | 'tap' | 'off', name?: our own name for it (1 to 40 characters) }`, or null when there are
none (it is cleared when the room is left). Only those keys and values are accepted. It is a
separate item, not a key of `r:<room id>`: an older version rejects a room item with unknown keys
as a whole, and ignores an unknown `p:` item (one with a key it does not know too). Like rooms and
marks, the choices are not carried in the link code; they follow when the devices meet.

Read marks: `k:<room id>` holds the newest message stamp read on any device and only moves
forward, so a room read on one device is not unread on the others. Rooms and marks are recorded
only while there are other devices (linking records the ones that exist), and a leave is announced
before the links close.

## Identity recovery

The main key lives only on the main device and cannot be read out of it. If that device loses its
data (the browser wiped it, the disk died), the identity would be gone and only the linked devices,
whose certificates stay valid, would still speak for it; none of them can link a new device.
A recovery code closes that gap without exporting the main key.

- **Making it (main device, Settings > Devices > Identity recovery).** The device makes a recovery
  key from a random seed and signs a *recovery certificate* for it (`knot/recovery`: "this key
  may certify devices for me"). The code holds the seed, that certificate and the secret of the
  devices' channel (below), encrypted with a passphrase (AES-GCM under PBKDF2, 600 000 rounds, the
  header authenticated), as `knot-ik1-...`. The device keeps only public facts about it (`recovery`:
  the recovery public key, when, whether the channel is in it); the code is shown once.
- **Using it (any device without rooms of its own, Settings > Devices > Restore your identity,
  or the button on the empty room list).** Code and passphrase give the recovery key back. It
  signs a device certificate for the device's own key, and the recovery certificate travels along
  (`up`), so anyone checks *main key -> recovery key -> device*: one hop, two signatures, and
  `r` of the certificate stays the main key's, so the member id is the old one. From then on the
  device is a linked device (owner rights included) and, with the channel secret from the code,
  meets the person's other devices at once: rooms, settings and aliases follow over the usual
  device sync, recent history through the usual history sync (at most the newest 500 messages per
  room and peer). Older history comes from a backup file.
- **One code at a time.** Making a new one withdraws the old key; "Cancel the recovery code" does
  the same. Withdrawing a recovery key (an `unlink` of its key, like a device's) makes every room
  refuse each certificate whose chain contains it, so devices created with it stop working
  too, and so does anybody who stole the code. It can be done from any device.
- **Not possible without the main device:** making a code (the recovery certificate needs the main
  key). After a restore there is no main device, so the code that was used stays the one
  recovery path.
- **A notice when it is used.** The first time a device whose certificate came through a recovery
  key connects to one of our devices (in a room or in the channel), every such device shows a bar
  "A device joined with your recovery code: <name>" with Review devices, "That was me" and
  Cancel the recovery code; the device is marked "restored with a recovery code" in the device list
  from then on (kept in the store as `restored`: key, name, recovery key, seen). Cancelling works
  from any device, because the recovery key is known from the notice: a leaked code needs no main
  device to be shut down. Unlinking that one device removes only it and its notice.
- **Who may do what.** Only the main device links a new device (`linkDevice`: the two-code flow,
  it signs the certificate with the main key) and makes recovery codes; a linked or restored
  device can do neither, and a device that is already linked is refused by `startLinking` until it
  leaves its link. After the main device is gone, new devices join by restoring with the code (each
  restore is one more device), not by being linked.
- **Old versions** reject chained certificates, so they drop what a restored device writes until
  their page has updated.

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
