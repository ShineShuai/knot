# Messages and history

How messages are ordered, synced and relayed, and the envelope kinds that ride on them (reactions,
edits, deletes, replies, image previews).

[Back to the README](../README.md)

## Ordering

Hybrid logical clock; far-future stamps are rejected/clamped.

## History

On every new link both sides exchange the ids of their recent messages and send what the other
lacks. Messages are gossiped to other links so a missing mesh edge heals; what a history sync brought is
passed on in `give` batches (50 per frame), never one frame per message. The log is a FIFO of
`logCap` messages.

## Relay fallback

While some known room member has no direct link, text is also published, AES-GCM sealed, on the
room's broker topic. A link is a path only while it is open *and* synced. Files never use it.

## Delivery receipts

A receiver confirms every `text`, `reply` and `file` it keeps (and, for a repeat of a message
younger than 5 minutes, again: the first confirmation may have been lost): `ack` {ids, by}, sent in
groups after 250 ms, on the direct link of the author's devices or, if there is none, over the
brokers with `to` (the author's member id). The sender shows ✓ (sent) and ✓✓ (confirmed by another
member; its own devices do not count) for the messages of this session. If nobody confirms, and
somebody else is around, it sends the message again through the brokers after 5 s, 20 s, 60 s and
180 s: a link can look open and carry nothing. Older versions ignore `ack`; they just never confirm.

## Over the brokers: member list and history

Pairs that cannot connect directly (NAT with no way through, no TURN) have only the brokers, and a
room with an owner needs more than messages there: a message from someone the receiver's member
list does not know is refused, and the list used to travel only on direct links. So the relay also
carries control frames (JSON with a `t`; older versions ignore them, they have no `id`):
`admin?` {head} asks for the member list, `admin` {es} answers it, `have` {ids, full} lists the
newest 40 messages, `give` {es} brings what the asker lacks. They are sent when a broker connects,
after `wake`, every minute while some member has no direct link, and `admin?` also when a message
is refused for its unknown author. Members answer after a random 0.1 - 0.9 s, and not at all if
somebody's answer was heard in the last 1.5 s. A message whose author is not yet in the list is
kept (200, 10 minutes) and shown as soon as the list learns the author; a banner says how many wait.
Every refusal is counted by reason (`room.dropped`) and Diagnostics prints them with what each
usually means. An `admin` frame holds at most 100 envelopes (all a receiver reads).

The owner's answer to a join request carries the member list too (`chain`: the start of it, up to
30 kB), not only the joiner's own admission: a joiner given only that one envelope has a hole in
their list that nobody may be able to fill when the owner is away, and every member who missed the
same change then refuses their messages for good (the joiner sees theirs, they do not see his).
The joiner checks each envelope like one from a peer; an older owner sends none. A member whose
list has a gap asks for it again every minute. Diagnostics shows per room the size and head of the
member list (the same head on two devices means the same list), a gap if one is known, and forks.

## Member list: what survives, what is said

An admin envelope that cannot be applied yet (an earlier link is missing) waits in memory, and is
also saved (`wait:<room>`), because a joiner's own admission may exist nowhere else: it came with
the grant, and a restart before the rest of the list arrived used to lose it, leaving the owner
the only holder. Our own member (and so every device of ours) is trusted by us without being in the
list, and links to our own devices count as synced: a linked device used to refuse the main
device's messages when the list lacked their common admission. What is still missing is said in
the room: a note when our own admission is not in our list (others will not see our messages), and
on the banner of waiting messages when the owner is offline (the list comes from the owner, or
from a member who has it). Diagnostics adds, per room, the owner (online or not), our own id, the
members, the author of the last refused message and which direct links are not synced.

A device can be in a room without being on its list: one that left its main device (or was
withdrawn) starts over with a new identity (`AppModel.forgetLinking`) and keeps its rooms, so in
every room with an owner it is a stranger, and what it writes is refused without a word (rooms
without an owner do not care, which hides it). When our own member is not on our list, and the
owner is online, the room asks them to let it in again, as a join link would (`rejoining`): the
owner gets the usual join request, with the name, and decides; nothing is admitted on its own.
The answer carries the member list and any key rotation missed. It asks again every few minutes,
not at all while the owner is away, and never again after a no. On the owner's side the banner of
waiting messages points to the join requests.

## App versions

Presence carries `pv`, a whole number that only goes up (`PROTOCOL` in `src/version.js`, with what
each level added), and `app`, the version string; both inside the sealed payload, so only members
see them. No `pv` means level 1 (an app from before it was announced). A room lists the members
online whose level is lower or higher than ours (`Room.appGaps`) in a note ("Ada: older app than
yours"), and Diagnostics lists the apps seen. Raise `PROTOCOL` with every change an older app
would not understand, and before the next one that changes the wire format.

## Reactions and edits

Two more signed envelope kinds that ride on another message. `react` {id, emoji, on}: per author,
message and emoji only the latest counts, so toggling never piles up (one envelope per slot; the
"off" one stays so an older "on" cannot return). `edit` {id, text}: only the message's author may
send it (checked on receipt, not only in the UI); the latest wins and replaces older edits. The
signed original is never changed, so the original text stays in the log and in the JSON export: an
edit corrects a typo, delete removes content. Deleting a message also drops its edits and
reactions, and later ones are refused. Reactions must be one emoji (checked on receipt). Both
travel and sync like messages and count against the log cap. The palette shows a quick row of six;
"＋" opens about sixty more and a box for any other emoji (typed or pasted from the keyboard's
emoji picker; anything `isEmoji` refuses is ignored). A person may react with as many different
emoji as they like.

## Delete and quote

A `del` envelope (signed by the author, naming one of the author's own message ids) makes every
peer drop that message's content from memory and storage and show "<name> deleted a message" in
its place; a copy that arrives later is refused. A deleted file is no longer offered and its
cached preview is purged. It cannot take back what was already downloaded, or what a modified
client keeps. `reply` envelopes carry a snapshot of the quoted message (id, name, 200 chars); the
UI hides the snapshot once the original is deleted.

## Image previews

An image is announced with a ~160 px thumbnail (<= 10 KB) inside the signed envelope, so it shows
at once, survives an offline sender and travels with history sync. A <= 1280 px preview (<= 600
KB) is a second, content-addressed "file" whose size and SHA-256 are in the envelope; it is
fetched when the message scrolls into view (Settings: auto / on tap / off), cached per room, and
any peer that has it can serve it. Originals <= 300 KB are their own preview. The full original is
loaded only on request. Peers sniff bytes instead of trusting mime types and check the pixel count
from the header before decoding. SVG is shown only through `<img>` (never as a document), rejected
with scripts/entities, and only when received whole (<= 2 MB).
