# Messages and history

How messages are ordered, synced and relayed, and the envelope kinds that ride on them (reactions,
edits, deletes, replies, image previews).

[Back to the README](../README.md)

## Ordering

Hybrid logical clock; far-future stamps are rejected/clamped.

## History

On every new link both sides exchange the ids of their recent messages and send what the other
lacks. Messages are gossiped to other links so a missing mesh edge heals. The log is a FIFO of
`logCap` messages.

## Relay fallback

While some known room member has no direct link, text is also published, AES-GCM sealed, on the
room's broker topic. Files never use it.

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
