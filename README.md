# Retro TV

A 1990s–2000s cable TV for the second monitor. Shows are already "on" when you tune in, you
flip channels through static, and there's a guide channel, an info banner, bumpers and
commercials, original off-air broadcasts, and a Library window for finding, downloading
and organizing your collection.

**Turn it on:** double-click `Retro TV.cmd`. It opens fullscreen on the second monitor.

## The remote

| Key | Does |
| --- | --- |
| ↑ ↓, Page Up/Down, mouse wheel | Channel up / down |
| 0–9 | Type a channel number |
| Backspace | Last channel |
| ← → or − + | Volume |
| M | Mute |
| G | TV Guide (↑ ↓ to browse, Enter to tune) |
| I or Enter | What's on |
| K | Who's watching: Kids / Family / Late Night |
| L | Open the Library window (asks for the PIN if one is set) |
| P | Press play, if a live channel is stuck |
| C | Old TV look on / off |
| H | Show the remote |
| Ctrl+D | Move to the other screen |
| Ctrl+Q | Turn off |

## The Library window (L)

Opens on your main monitor while the TV keeps playing.

- **Find** searches the Internet Archive: the VHS Vault (off-air TV recordings), its kids'
  collection, classic TV, Prelinger, or all video. Filter by network, years, and kind
  (complete broadcasts, episodes, commercials, bumpers). Open an item to see every file with
  resolution, length, size and bitrate. Each version group has one file marked
  **recommended**: the uploader's original when it plays as-is, otherwise the best playable copy.
  Files marked **won't play as-is** (DVD `.VOB`, AVI...) need FFmpeg conversion first.
  Pick where downloads go (inbox, a channel, a show folder, bumpers or commercials) and tag
  network, year, rating and "complete broadcast" before downloading.
- **Downloads**: two at a time, with progress, speed and time left, pause/resume, retry, and
  resume after closing the app. Every Internet Archive file is checked against the archive's
  MD5 checksum. Nothing is ever overwritten (`name (2).mp4`), and files you already have are
  recognized.
- **My Library**: everything under `media/`, with metadata you can edit (show, season,
  episode, network, year, air date, rating, complete broadcast...). Move files onto
  channels, import videos from anywhere on your PC (they're copied, the originals stay), compare
  versions side by side, and inspect quality with ffprobe.
- **Channels**: add folder channels and set how each one plays.
- **Channel health**: every channel's state, two ways. *Right now* asks each service whether the
  channel is on the air (Pluto's current lineup, Owncast and Twitch status, whether a YouTube
  live stream is still live and allows embedding, how many videos a scheduled channel has).
  *On the TV* is how it has actually played: last success, failures and their reasons. Each is
  **healthy**, **degraded**, **unavailable** or **unverified** (can't be checked from here, such
  as a web player or Vaughn, which blocks automatic checks). "Off the air right now" is marked
  as temporary. **Check again** re-checks one channel; for a YouTube live channel it first looks
  for the channel's current stream. Checks only run when you ask.
- **Your drives** and **Phone at home**: see [docs/LAPTOP-SETUP.md](docs/LAPTOP-SETUP.md).

Changes show up on the TV within a second or two; no restart needed.

### When something won't play

The schedule never changes because a video failed. Instead, in that time slot the TV:

1. tries the same video again once (a network hiccup, or a video that didn't start within 25
   seconds or stopped buffering for 20),
2. tries another copy of the same program, when one is known,
3. plays a stand-in for the rest of the slot: an episode of the same show if there is one,
   otherwise another program from the same channel (ads stand in for ads). The banner and
   guide say "stand-in", and the Channel health tab lists recent stand-ins,
4. shows PLEASE STAND BY until the next slot if nothing else will play.

A video that failed rests before it's tried again (1 minute, then 2, 4, ... up to 6 hours; a
YouTube video that was removed or made private rests 6 hours straight away), so the TV doesn't
keep stumbling on it. One good play clears it. The PC TV and the phone use the same rules
(`src/health.js`) and pick the same stand-in for the same slot. A live channel that never starts
gets one fresh reload of its page before it counts as failed.

## Channels

### Live web channels (2–14)

Listed in `channels.json`. Each one opens the stream site's own player and crops it to just
the video. `type` is `twitch` (`"channel"`), `vaughn` (`"channel"`), `owncast` (`"url"`) or
`web` (`"url"`, plus `"start": "<css selector>"` for a button to press first). Set
`"enabled": false` to hide one. Twitch and Owncast show **OFF THE AIR** when they aren't
streaming; with no internet, live channels show **NO SIGNAL** and your own channels keep working.

### More live channels (15–19, 70–91)

- **15–19:** Cartoon Cartoons Network, CerealBowl Cartoons, RetroStrange TV (public domain),
  the Old Timey Computer Show, and Giant Bomb Forever. These are fan-run and official 24/7
  streams on Owncast and Twitch, and they work on the phone too.
- **70–89, Pluto TV** (free, no account, desktop only): 90's Kids, 90s Kids TV 2, Nickelodeon,
  Nick Jr., Totally Turtles, Garfield and Friends, Go Go Gadget!, Pokémon, Mister Rogers,
  Sailor Moon, Naruto, Inuyasha, Yu-Gi-Oh!, Pluto TV Anime, TV Land Sitcoms, Classic TV Comedy,
  iCarly, Degrassi and Vevo '90s.
- **90–91:** the official 24/7 MST3K and RiffTrax channels on Twitch.

Each has a rating, so the Kids profile only sees the kid-rated ones. Pluto TV only streams in
the US.

### YouTube channels (200–229, 300–306)

Two kinds, both in `channels.json`, both on the desktop and the phone:

- **Live streams** (200–229): official 24/7 streams such as Dexter's Lab, Ed, Edd n Eddy,
  Courage, Total Drama, Scooby-Doo, SpongeBob, Gravity Falls, Power Rangers, G.I. Joe, Yu-Gi-Oh!,
  Goosebumps, Arthur and Teletubbies. A 24/7 stream gets a new video ID whenever it restarts, so
  each channel names the YouTube channel and some title words, and the app finds the current stream:
  ```json
  { "number": 205, "name": "Total Drama Island", "type": "youtube-live",
    "channelId": "UCaf_hcOZous_DNct6xmc-Ow", "match": "total drama island", "rating": "TV-PG" }
  ```
- **Scheduled channels from playlists** (300–306): Nicktoons '90s, Cartoon Network Classics,
  Disney Afternoon, Toonami, Saturday Morning, Pokémon, Singing Shows. They run on the same 24/7
  schedule as your own files, with commercial and bumper playlists in the breaks:
  ```json
  { "number": 300, "name": "Nicktoons '90s", "type": "youtube",
    "playlists": [ { "id": "PL...", "show": "Rugrats" }, { "id": "PL...", "show": "Hey Arnold!" } ],
    "videos": [ "a video ID or link", "..." ],
    "commercials": [ "PL..." ], "bumpers": [ "PL..." ],
    "breaks": { "bumpers": 0, "commercials": 2 }, "minMinutes": 6 }
  ```
  `videos` is for making your own lineup from individual videos. Playlist entries can be bare IDs
  or links, or `{ "id", "show", "match" }`. Episodes shorter than `minMinutes` (default 6) are
  skipped, and when most of a playlist's titles name its show, videos that don't are skipped
  (`match` sets the words yourself). This clears out the clips and unrelated videos that fan
  playlists pad themselves with.

More options for `"type": "youtube"` channels:
- `"fromChannel": { "handle": "LimitlessWrestling", "skip": "shorts|music videos" }` uses every
  playlist a YouTube channel publishes (new ones are picked up automatically), skipping playlists
  whose titles match `skip`.
- `"dedupe": true` drops re-uploads of the same event or match: same video, or the same title
  once dates, numbering ("I" = "1") and filler words are set aside, with matching length. Weekly
  shows with different dates, different years and differently worded match titles stay separate.
  List the best source first; it wins.
- `"dedupeAgainst": [400, 401]` also drops anything already on those channels, so nothing airs twice.
- `"skip": "deutsch|german"` drops videos whose titles match; `"minMinutes"`/`"maxMinutes"` bound
  the length.

The wrestling channels use all of these: **400** Classic Wrestling '80s (WWF, AWA, NWA/WCW, WCCW
full shows), **401** WWE Vault Events, **402** WWE Vault Stories (documentaries), **403** WWE Vault
Matches and **404** Limitless Wrestling. 403 and 404 are rated TV-14 (Late Night).

Videos always play in YouTube's own player, so YouTube's ads can appear, and the next episode starts
when the video really ends. Playlists refresh every 3 days and live streams every 20 minutes. Most
"full episodes" playlists are fan uploads and can lose videos or disappear; the live streams and the
singing-show playlists come from official channels. The phone gets its YouTube lineup when the app is
published (`node scripts/deploy-mobile.js`), so republish now and then to refresh it.

### Your own channels (folders)

```
media/
  inbox/                          <- downloads and imports wait here until you assign them
  channels/
    21 Cartoon Network/           <- "<number> <Name>"
      channel.json                <- optional settings (below)
      Dexter's Laboratory/        <- subfolders become show names in the guide
      _bumpers/  _commercials/    <- optional: this channel's own breaks
    60 Original Broadcasts/
      Cartoon Network/
  bumpers/   commercials/         <- shared breaks for every channel
```

A folder channel appears on the TV once it has something playable for the current
profile. The starting lineup is 20 Kids TV, 21 Cartoon Network, 22 Nickelodeon, 23 Disney
Channel, 24 Saturday Morning, 30 Toonami, 31 Classic Anime, 40 Adult Swim, 41 Late Night TV,
42 Classic G4, 50 Classic Sitcoms, and 60 Original Broadcasts.

Every channel runs a fixed 24/7 schedule, so it's mid-show when you tune in and the guide
knows what's on later.

**Two kinds of programming:**
- **Episodes**: after each one, the TV inserts bumpers and commercials (default 1 bumper and
  3 ads; change `breaks`).
- **Complete broadcasts**: recordings that already contain their original commercials and
  bumpers. The TV adds nothing, plays them in air-date order, and the banner shows
  "Original broadcast · Cartoon Network · aired January 26, 2000". A whole channel can be
  broadcast-only (`"mode": "broadcast"`, like 60), or you can tick "Complete broadcast" on
  individual files on any channel. Adult Swim recordings go on 40, not 60.

### `channel.json`

```json
{
  "mode": "episodes",
  "order": "shuffle",
  "breaks": { "bumpers": 1, "commercials": 3 },
  "rating": "TV-Y7",
  "description": "Shown in the Library",
  "blocks": [
    { "name": "Toonami", "days": ["mon", "tue", "wed", "thu", "fri"], "start": "17:00", "end": "19:00", "channel": 30 },
    { "name": "Cartoon Cartoon Fridays", "days": ["fri"], "start": "19:00", "end": "22:00", "shows": ["Dexter's Laboratory", "Johnny Bravo"] }
  ]
}
```

- `mode`: `episodes` or `broadcast`. `order`: `shuffle` or `sequential`.
- `blocks` are time slots that take over the channel: `days` (optional), `start`/`end` (24 h,
  may cross midnight), `shows` (show folder names; empty means all), `channel` to borrow
  another channel's shows, plus optional `breaks` and `order`. A block cuts in on time, like
  the real schedule. Outside blocks, the channel's regular rotation plays. The 21 Cartoon
  Network template approximates its 2001 lineup and is **not** a verified historical listing.

## Profiles and PIN

In `channels.json` → `settings`:

```json
"pin": "1234",
"defaultProfile": "family",
"profiles": {
  "kids":   { "label": "Kids",   "channels": ["4", "5", "20", "22", "23", "24"], "maxRating": "TV-Y7" },
  "family": { "label": "Family", "channels": ["2", "4", "5", "7-11", "20-24", "30", "31", "50", "60"], "maxRating": "TV-PG" },
  "late":   { "label": "Late Night", "channels": ["*"], "locked": true }
},
"profileSchedule": [
  { "at": "07:00", "profile": "kids" },
  { "at": "19:30", "profile": "family" },
  { "at": "22:00", "profile": "late", "days": ["fri", "sat"] }
]
```

- `channels`: numbers, ranges (`"20-24"`) or `"*"`. A channel's `rating` (in `channels.json`
  or `channel.json`) above `maxRating` hides it.
- `maxRating` also filters individual files by their rating. Unrated files are allowed unless
  the profile has `"allowUnrated": false`.
- `locked` profiles and the Library window ask for the `pin`. With no PIN set, nothing is locked.
- `profileSchedule` switches profiles automatically at those times, without asking for the PIN.
  At power-on the scheduled profile wins.

## Quality

- Keep originals. Nothing is re-encoded on download or import.
- Best format for the TV: H.264/AAC MP4. WebM and most H.264 MKV play too.
- **FFmpeg** (installed with `winget install Gyan.FFmpeg`; found automatically, or set
  `"ffprobePath"` in `channels.json`): the Library shows codec, bitrates, aspect, frame rate,
  interlacing and problems, and the TV skips files that can't play.
- **Make it play on the TV**: open a file in My Library that's marked "won't play" or
  "interlaced", or use **Convert all that won't play**. Retro TV does as little as possible:
  - *Rewrap* (H.264 + AAC/MP3 in another container): copied into MP4, no quality loss, seconds.
  - *Audio only* (H.264 with AC-3/MP2...): the video is copied, the audio becomes AAC.
  - *Re-encode* (MPEG-2, Xvid/DivX, WMV, interlaced video): H.264 CRF 18 with the slow preset,
    `bwdif` deinterlacing for interlaced sources, display aspect kept (4:3 stays 4:3).
  - DVD titles split into `VTS_01_1.VOB`, `VTS_01_2.VOB`... are joined into one file; the menu
    (`_0.VOB`) is skipped.
  - Optional *Even out loudness* (EBU R128) for tapes with wildly different volume.
  The result is a new `.mp4` next to the original, carrying over its details. The original is
  never changed or deleted. Progress and cancel are in the Downloads tab.
- 4:3 shows stay 4:3 (pillarboxed, never stretched).

## Settings (`channels.json` → `settings`)

- `display`: `"secondary"` (default), `"primary"`, or a monitor number (0, 1, ...)
- `startChannel`: the channel on first launch (afterwards it remembers the last one)
- `crt`: the scanline/old-TV look (toggle with C)
- `mediaFolder`: where `media/` lives, e.g. `"D:/TV"` for a big drive
- `localOrder`, `breaks`: defaults for folder channels

## Phone and tablet app

A separate version for iPhone and iPad that runs entirely on the device, no PC needed.
Open its web address in Safari, tap Share → **Add to Home Screen**, and it opens fullscreen
like an app. It works with no signal once it has been opened once.

- Same TV: channels already on, static, banner, guide, time blocks, complete broadcasts,
  bumpers and commercials, Kids / Family / Late Night profiles and the PIN.
- Portrait: the TV on top, a remote with a number pad below. Landscape: fullscreen; tap
  for the banner and a floating remote. Swipe up/down on the picture to change channels.
- **Your videos live on the device.** Copy MP4s to the Files app (iCloud Drive, AirDrop or a
  cable), then MENU → Add. Only MP4/M4V/MOV play on iPhone and iPad; convert other files on the
  PC first.
- **Same setup as the PC:** in the Library window's Channels tab click **Export for phone**,
  put the file on the device, and import it in MENU → Settings. You get the same channels,
  time blocks and profiles (not the PIN; set that on the phone), and videos you add are filed
  onto the right channel by name.
- **Find** searches the Internet Archive. Videos added from there stream when they're on
  (internet needed). To keep one offline: Watch → share → Save to Files → Add.
- Live channels on the phone: RetroBlast, Swim Rewind and Twitch channels. Vaughn channels,
  Toonami Aftermath and myRetroTVs only work in the desktop app.
- iOS may clear the app's videos if the device runs very low on space; keep originals on the PC.

To build and publish it: `npm run build:mobile` builds into `dist-mobile/`,
`npm run serve:mobile` tries it at http://localhost:5173, and `node scripts/deploy-mobile.js`
publishes it to GitHub Pages. Only the app code and the channel lineup are published: never
videos or the PIN.

## For developers

`npm test` runs the unit tests (paths, probe parsing, library, Internet Archive parsing against
captured responses, downloads against a local server, schedule, profiles, playback health and
recovery, channel checks against fake provider answers, the home server, linked folders). `docs/REPORT.md` has
the audit, the source research and the design.
