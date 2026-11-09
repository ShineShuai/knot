# User interface behaviour

What the user sees and the rules behind it: dialogs, rooms, composer, links, unread counts,
search, export, language.

[Back to the README](../README.md)

## Dialogs

Each ends with a footer: the action that applies what was changed and Cancel (New room: Create
room, Join: Join, Export: Export), or a single Close for a dialog that only shows things (invite,
members) or that applies its changes itself (Settings). The × in the corner is a Cancel: whatever
was not applied is dropped.

## Settings

One dialog, built by `ui/settings-shell.js`: a list of pages (General, Notifications, Network,
Devices, Data, About) beside the open page. On a screen narrower than 720px the list and the page
take turns (a Back button on the page). Only the open page is in the document, but a page keeps
what was typed while another is visited. A chip on each page says who its settings reach: *All
your devices* (the keys in `SHARED`, `chat/device-sync.js`: the chip is derived from it) or *This
device*.

- **Applied at once:** language, name, image previews, notifications (the permission prompt needs
  that click; if refused the switch goes back off).
- **Apply and Revert:** network (brokers, relay, STUN, TURN) and device names. A wrong broker or
  STUN list can cut a person off from every room, so these are checked while typed
  (`networkProblems` in `config.js`: the message is shown under the field, Apply is off) and saved
  together. TURN servers are rows (address, user, password); *Reset to defaults* fills the
  controls and still waits for Apply.
- **Closing with changes that were not applied** (an Apply bar showing on any page) asks first,
  for ×, Close and Escape alike; so does choosing a new language, which draws the dialog again.
  The same frame serves the room settings. (Chrome lets a second Escape through without asking.)
- **Notifications** shows what the browser says (not asked yet, allowed, blocked) and, when
  blocked, where to change it.
- **Devices** is the old Linked devices dialog; **About** has the version and the diagnostics
  report; **Network** has the link to the network test page. `SettingsDialogs.open(page)` and
  `devices()` open the dialog at a page.

## Room names

"New room" opens a dialog (name, Create or Cancel): nothing exists until Create is pressed, and a
double click makes one room. The default name is the first free "Room N". A room is renamed in its
settings (Overview); names are local to each person (the label travels only between a person's own
devices). The room list is saved one write at a time, so rooms created together are all kept.

## Room settings

The ⚙ in the room header opens them (a count on it: join requests and unknown senders waiting for
the owner; the count beside *Members* in the dialog follows them while it is open). They use the
same frame as the app's Settings (`ui/settings-shell.js`, opened by `ui/room-settings.js`). The
header keeps back, title, search, broker state, calls, Invite and ⚙; rename, export, the member
list and Leave moved in.

- **Overview:** *Your name for this room* (applies at once; only you see it; empty takes it back,
  and the room is then shown under the owner's name for everyone, if there is one, else the name it
  was first given), your role (owner, member, or an open room without an owner), the owner and the
  number of members.
- **Members** (rooms with an owner): the member list, join requests, senders not on the list, the
  recovery code, and the join link and pairing code. Members see the list only.
- **Rules** (rooms with an owner): what the owner decided for everyone: *Joining* (owner approves,
  or closed), *Who can write* (everyone, or owner only), *Sharing files*, *Calls*. The owner edits
  them and publishes them together (*Publish rules*; besides the four above: *Name for everyone*,
  *Largest file*, *Owner can delete others' messages*) and is told which members online run an app
  too old to know them; members see them, read-only, with the name of the owner. The message box
  shows *Only the owner can write here* when writing is closed to you, the attach button and the
  call buttons are not offered when files or calls are off, and the conversation notes "Ada
  changed the room rules". See security.md.
- **My preferences:** *Mute this room* (no notifications, not counted in the tab title or the app
  badge; the room list shows 🔕) and *Image previews in this room* (use the app setting, or
  auto / on tap / off). Export of the history (text or signed JSON) is here too.
- **Leave room:** asks first, as before.

The choices of *My preferences* are only the person's own: they are kept per room
(`AppModel.roomPrefs` / `setRoomPrefs`, `Room.prefs`, `room.muted`, `room.previewMode`) and follow
the person to their other devices (`p:<room id>`, see devices.md); other members never see them.

The dialog of both settings has the class `paged` (not `shell`: that is the page's own layout).

## Membership notices

Admissions, removals, hand-overs and recoveries appear in the conversation as one quiet line ("Bob
joined"); recovery keys never do.

## Attachments

Pasted, dropped and picked files wait in the message box (chips with a preview and a remove
button) and are sent, to everyone, only with Enter or Send: files first, then the text. The
message box grows with its text up to a cap.

## Links

`http://` and `https://` addresses in message text become links that open in a new tab with
`noopener noreferrer`. Only plain-ASCII addresses with a dotted host (or `localhost`) are linked,
never ones with a user name or password (`https://bank.com@evil.test`), other schemes
(`javascript:`, `data:`), or addresses over 2000 characters; so look-alike letters and hidden
direction marks cannot pass for a known site. Trailing punctuation and unmatched closing brackets
stay outside the link. The text itself is never changed (and signed as typed); hovering a link
shows the address it really goes to. Quotes and notifications show plain text.

## Unread and notifications

Each device keeps, per room, the stamp of the newest message it has shown (`read:<room>` in
storage; on first run everything already there counts as read). Messages from others after that
stamp are "unread": counted in the room list, in the tab title `(3) knot` and on an installed
app's icon (a muted room is not counted in the last two, and gives no notification). A room on screen (page visible and focused) is read at once. Settings > "Notify me
about new messages..." asks the browser for permission (from the click) and then shows one
notification per room, with several arrivals summed up. Notifications go through the service
worker when there is one (phones need that; clicking opens the room). There is no push server, so
they only work while the app is open somewhere.

## Search and export

The search box (🔍) filters the conversation to messages whose current text or file name contains
every word (case and accents ignored); it covers what this device holds (the log, up to `logCap`).
Export (room settings > My preferences) saves that same history as readable text or as the signed
envelopes (JSON, verifiable); shared files are not included.

## Connection reveal

Hold V (or press and hold the member strip) to see per member: direct / through NAT /
TURN-relayed, candidate types, protocol, round-trip time and how they were found
(`PeerLink.stats()` from `RTCPeerConnection.getStats()`).

## Version and language

The version (`src/version.js`, kept equal to `package.json` by a test; bump both for a release)
sits next to the title in the room list. Settings > Language picks Automatic (the browser's),
English, 中文 or Deutsch; the choice is stored with the other settings and redraws everything on
screen at once (a running call goes on). To add a language: a dictionary and a `LANGUAGES` entry
in `ui/i18n.js`; a test fails while any text is missing or its `{placeholders}` differ.

## Notices

Short messages (errors, confirmations) appear in one toast at the bottom. It is a manual popover
(`showPopover`), shown again on every notice, so it sits in the top layer above an open modal
dialog; without it every notice raised from a dialog would be hidden behind that dialog. Browsers
without popovers fall back to the old behaviour, so anything a dialog must tell the user is also
written inside the dialog (see *Keeping your data* in [operations](operations.md)).
