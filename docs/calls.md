# Calls

Audio and video in a room: mesh topology, signalling, video quality control, chat and files during
a call, screen share.

[Back to the README](../README.md)

## Mesh and signalling

Audio and video for up to `callMaxParticipants` (6) people, in a mesh: everyone in the call holds
one media connection to everyone else, so there is no media server (and no per-person cost beyond
bandwidth: video quality per stream shrinks as people join). Who is in the call, and the SDP of
each media connection, travel as `{t:'call'}` frames over the room's authenticated direct chat
links, never over the brokers and never in the message log. Only members (peers the room has
accepted) can send them, and each media connection's DTLS fingerprint rides inside that
authenticated channel, so a call is tied to a known identity.

Each pair has one connection with two fixed transceivers (audio, video); the peer with the smaller
id always offers. Muting is `track.enabled`, the camera is `replaceTrack` (off stops the capture,
so the light goes out): neither renegotiates. A connection that dies is offered again with growing
pauses. Alone in a call for `callAloneMs` (5 min: nobody else joined, or everyone left), you leave
it and get a notice.

Camera and microphone are asked for only when you join (or turn the camera on); a refused device
still lets you listen.

### Video quality

It favours audio first, then smooth motion (no queueing, so no added delay), then sharpness. The
camera is captured at up to 720p/30; each connection encodes only what it can carry and the
receiver shows (`call/quality.js`, no renegotiation, only `setParameters`): a ladder of rungs
(180p/15 fps/100 kb/s up to 720p/30/1.8 Mb/s; a screen share has its own, sharper and slower)
capped by the head count, by the receiver's tile (`want` frames: tile height in pixels, 0 for a
hidden tile or a page out of sight for 5 s) and by what the connection proved (`getStats` every 2
s: loss, round-trip time, the browser's own limit/estimate where it reports them). Down is fast
(two bad samples, or one severe: two rungs), up is slow (one rung after 8 s calm, longer after a
failed try). If even the lowest rung does not fit, video pauses for that peer (their tile says
so), audio goes on, and video is tried again after a pause. Cameras degrade by resolution first,
screens by frame rate (`degradationPreference`, where the browser has it).

The connections of a call share one uplink, so they take turns: one steps down per review, one
climbs at a time, and only while none suffers (severe trouble acts at once). A rung that failed is
not tried again blindly for 45-180 s, so the picture does not jump up and down; where the browser
does not say why it holds back (Firefox, Safari), frames smaller than asked for are the sign.
Settings > Diagnostics lists every call connection (rung, bitrate, frame size and rate, loss,
round-trip time, the browser's limit and estimate, what each side asked for, what we receive).

### Window, chat and files

One call at a time per device; it keeps running while you read another room ("minimize"). Texting
and files work during a call: the chat button (💬) puts the room's conversation next to the video
(call at the side on a desktop, on top on a phone) with the usual message box, drop, paste and
reactions, and counts what arrives while the call covers the conversation; "minimize" leaves a bar
*below* the conversation, so the message box stays free.

Files use their own data channel, so a transfer shares bandwidth with the call but needs no extra
connection. The call bar has a file toggle (📎): paused, this device neither shares, serves nor
fetches files and waits with image previews (thumbnails and text are not affected; a peer asking
gets "paused during a call"); it is local to the device and ends with the call.

### Participants and speaking

Everyone in the call is always shown, camera or not: a person without video gets an avatar, the
grid divides its space by head count (nobody scrolls out of view, also beside the chat or above it
on a phone), and the minimized bar names everyone (🔇: muted, …: connecting).

The person who is speaking gets an outline on their tile (and 🔊 in the minimized bar): each audio
stream is measured in the browser (Web Audio analyser, nothing is played or recorded), above a
small loudness threshold and held for 0.4 s so it does not flicker; our own microphone counts too,
a muted one is silent. Browsers without Web Audio just show no highlight.

Call signalling travels on direct links only, so someone without a direct link to you cannot be
listed.

### Screen share

Desktop browsers can share a screen, window or tab instead of the camera (the tile shows it whole,
not cropped; the browser's own "stop sharing" button ends it); phones have no screen capture, so
they only get the camera. Needs HTTPS or localhost. Without a TURN server (Settings) two people
behind strict NATs cannot connect, same as chat.
