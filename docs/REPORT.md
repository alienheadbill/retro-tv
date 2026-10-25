# Retro TV: audit, source research and expansion plan

Research date: 2026-10-23. Every availability claim below was checked live that day through
the source's own API or HTTP responses. Sizes and counts will drift as archives change.

## 1. Current architecture (before this work)

| Layer | Files | Role |
| --- | --- | --- |
| Main process | `main.js` | Picks the TV monitor, fullscreen frameless window, popup/permission lockdown, scans `media/channels/<n> <Name>/`, caches durations, channel status (Twitch GQL, Owncast `/api/status`) |
| Bridge | `preload.js` | `window.tv` API: `config`, `durations`, `saveDurations`, `status`, `nextDisplay`, `quit` |
| TV renderer | `src/app.js` | Tuning, live `<webview>` channels, local playback, volume, OSD, banner, remote keys |
| | `src/schedule.js` | Fixed 24/7 timeline anchored at 2000-01-01, seeded shuffle, show + bumper + commercials segments, guide listings |
| | `src/isolate.js` | Injected into live pages: finds the main player, fills the screen with it, hides everything else |
| | `src/guide.js` | TV Guide grid with picture-in-picture |
| | `src/effects.js` | Static (canvas + Web Audio hiss), power on/off |
| | `src/index.html`, `src/style.css`, `src/fonts/VT323-Regular.ttf` | Layout, CRT look, VCR font |

Security model: live pages run in `<webview>` guests with the `persist:tv` partition, no
preload and no Node. Popups and new windows are denied, and every permission request is refused.
The TV page itself only reaches the main process through the narrow `window.tv` bridge.

## 2. Working functionality (verified in this session)

Fullscreen secondary-monitor playback, number and up/down tuning, last channel, static
transitions, CRT overlay, guide, info banner, volume/mute, help overlay, local channels
with mid-episode tuning, bumper and commercial insertion, duration cache, Owncast and Twitch
on-air detection, real-click auto-start for players that wait for a click, and color-bar
"stand by" fallbacks. A harness drove the packaged app through every live channel and a
local channel and captured screenshots.

## 3. Missing or problematic pieces

- No file is missing. `src/` is complete.
- No library metadata. Everything is derived from file names at scan time.
- No FFmpeg/ffprobe on this PC, so there's no codec, bitrate or interlacing inspection. Durations come
  from Chromium, which can't open MPEG-2 (DVD `.VOB`), AVI or many older codecs.
- No way to find, download or import media from inside the app.
- One playback style only: every file gets commercials inserted after it, which is wrong for
  recordings that already contain the original ads.
- No profiles. Swim Rewind (Adult Swim) is one channel-up away from Nick.
- Empty local channels would appear in the lineup as "NO SHOWS YET".

## 4. Best sources for this content

| Source | What's there | Full episodes / broadcasts | Direct download | API | Verdict |
| --- | --- | --- | --- | --- | --- |
| **Internet Archive: VHS Vault** (`vhsvault`) | ~125,600 items of off-air VHS recordings, tapes, openers | Both: many multi-hour off-air broadcasts **with original commercials and bumpers** | Yes, every file | Yes (search, metadata, files) | **Primary source** |
| ↳ Kids' Shows on VHS (`vhskids`) | ~12,700 items | Both | Yes | Yes | Primary for kids |
| ↳ `CCF-2000` | Cartoon Cartoon Fridays 2000, "The Mayor Hosts", full broadcasts | Complete broadcasts | Yes. DVD `VIDEO_TS` (MPEG-2 VOB, 640×480) plus IA h.264 copies. 5.8 GB | Yes | Great; VOBs need FFmpeg |
| ↳ `CNDump2` | Early-2000s Cartoon Network, Disney Channel, Fox Kids, PBS **with ads**, 1999–2000s, 2–5 h each | Complete broadcasts | Yes. Original MPEG-4, 640×480. 206.7 GB total | Yes | Excellent for channel 60 |
| `zzAdultSwimBroadcasts` | Adult Swim 2004–2006 (FMA, GitS, Inuyasha, Bebop, ATHF, Code Geass, Death Note) | Complete broadcasts | Yes. MPEG-4 640×480 (one file is 320×240). 9.2 GB | Yes | Great for channel 40 |
| `AdultswimBumps` | **14,774 videos** of Adult Swim bumps, promos, disclaimers, Toonami intros; mostly small MPEG-4 originals (480p/720p) with MD5 | Bumpers | Yes | Yes | Best bumper source found; verified by real downloads |
| `yt-UCq3nKu5wqXi0kXYSdjdRjpg` ("A Nostalgic Experience") | 90s kids' commercial compilations, 52 videos | Compilations | Yes. Matroska 640×480 originals plus Ogg derivatives. 9.8 GB | Yes | Commercial-break filler |
| Searches across IA (`mediatype:movies`) | Toonami ~1,330 items, Nickelodeon 90s/00s ~1,450, Adult Swim ~8,400, bumpers ~3,430, G4/X-Play/AOTS ~1,800, `AdultswimBumps` | Mixed | Yes | Yes | Searchable from the new Library window |
| Prelinger Archives (`prelinger`) | ~10,500 mid-century ephemeral films | Full films | Yes | Yes | Era-wrong, but public domain filler for odd hours |
| `classic_tv` | ~11,450 items, sub-collections by decade incl. `classic_tv_1990s` | Episodes | Yes | Yes | Worth browsing |
| Wikimedia Commons | Animated films category (27 entries, mostly modern CC/PD shorts, up to 1080p WebM) | Shorts | Yes | Yes (MediaWiki) | Low value for the era; adapter-ready later |
| Library of Congress National Screening Room | 1,294 items, mostly pre-1950s film | Full films | Some | JSON (`?fo=json`) | Era-wrong; skip |
| Blender open movies | 2006–2008 CC shorts | Shorts | Directory returns 403 to scripted requests | No | Skip, or download manually |
| Vimeo | Creator uploads | Varies | Only when the uploader enables downloads | OAuth token required | Streaming-only for our purposes; not integrated |

The listed IA collection items are user uploads of off-air recordings. IA's metadata does
not carry a license for them (`licenseurl` is empty). Retro TV records that field when present
and does not block anything on it.

## 5. Download facts that shape the design (verified)

- `https://archive.org/download/<item>/<file>` → **302** to a storage node
  (`dnXXXX.ca.archive.org`) → **200**, `Accept-Ranges: bytes`. A range request returns **206**,
  so interrupted downloads can resume.
- `https://archive.org/metadata/<item>` returns every file with `size`, **`md5`**, `sha1`,
  `format`, `source` (`original` vs `derivative`), `length` (seconds), `width`, `height`, `mtime`.
  That gives exact verification and quality info **before** downloading.
- `https://archive.org/advancedsearch.php` (JSON, sortable, paged) searches collections, titles,
  dates, subjects. Bulk paging past 10,000 results uses the scrape API.
- Each item usually contains the **uploader's original** (often the best master) plus IA-made
  derivatives (`h.264 IA`, `512Kb MPEG4`, `Ogg Video`), which are re-encodes. Prefer originals.
- Open searches can surface adult material (seen in a "commercials" search). The Library window
  scopes searches to the VHS Vault collections by default.

## 6. Video quality strategy

1. **Pick the right file before downloading:** original over derivative, then higher resolution,
   then higher bitrate (size ÷ length). The IA metadata already includes these.
2. **Keep originals untouched.** Never re-encode on import.
3. **Inspect with ffprobe when available:** codec, resolution, SAR/DAR, field order (interlacing),
   bitrates, frame rate, duration and stream integrity. The app works without FFmpeg and falls back to
   Chromium for duration and size.
4. **Compatibility:** Chromium plays H.264/AAC MP4, VP8/VP9/AV1 WebM and most H.264 MKV. MPEG-2
   VOB/MPG, AVI (DivX/Xvid) and WMV need FFmpeg, either a lossless *remux* where possible or a
   transcode to H.264/AAC (CRF 18, `-preset slow`, `yadif`/`bwdif` deinterlace for interlaced
   sources, aspect flags preserved). Not built yet; listed in the plan.
5. **4:3 stays 4:3.** The player letterboxes with `object-fit: contain` and never stretches.
6. Nothing is labelled "restored". Upscales or re-encodes would be recorded as derivatives.

## 7. Media management architecture (implemented)

- `media/.retrotv/library.json` is the index (one JSON file; thousands of entries load in
  milliseconds, so SQLite isn't needed yet). Each entry is keyed by media-relative path:
  size, mtime, md5, and `meta` (show, episode, season, episode number, network, year, air date,
  category, rating, complete broadcast, embedded ads, source, source URL, imported date) plus `probe`
  (ffprobe results).
- `media/inbox/` is where downloads and imports land before being assigned.
- `media/channels/<n> <Name>/channel.json` (optional) holds per-channel settings: `mode`
  (`episodes` / `broadcast`), `order`, `breaks`, `blocks` (dayparts), `rating`.
- `lib/` holds main-process modules: `paths` (safe names and containment), `library`, `probe`,
  `downloads`, `sources/archive-org`, `sources/index` (adapter registry).
- A separate **Library window** (`manager/`) with its own narrow `window.library` bridge.

## 8. Download manager design (implemented)

A queue persisted to `media/.retrotv/downloads.json`, 2 concurrent transfers, `.part` files with
HTTP Range resume, speed/ETA, pause/resume/remove, and MD5 verification against the source
checksum. The final file never overwrites (`name (2).mp4`). Duplicates are caught by source
identity and by MD5 against the library. Hosts are restricted to the source adapters' allowlist
(archive.org and its storage nodes), extensions to video and subtitles, and file names are
sanitized and confined to `media/`.

## 9. Features that must be preserved

All remote keys, channels 2–14 and their settings, `media/channels/<n> <Name>/` layout,
`_bumpers`/`_commercials`, shared `media/bumpers` and `media/commercials`, `window.tv`,
`channels.json` compatibility, multi-monitor handling, CRT/static/guide/banner, and live-channel
isolation.

## 10. Prioritized plan

| # | Item | Status |
| --- | --- | --- |
| 1 | Library index, metadata guessing, ffprobe inspection | **Done**, verified with FFmpeg 9.0.2 (installed via winget) on real files |
| 2 | Internet Archive adapter: search, item files with quality ranking, download URLs | **Done**, tested against captured API responses and live |
| 3 | Download manager (resume, verify, dedupe, queue) | **Done**, tested locally (pause/resume, bad checksum, HTML pages, bad hosts, unsafe names) and live (3 real archive.org files, MD5-verified) |
| 4 | Library window: search, downloads, library, import, compare, assign, channel settings | **Done**, driven end to end |
| 5 | Complete-broadcast mode (no inserted ads, air-date order, banner shows network and air date) | **Done** |
| 6 | New lineup 20–60, empty channels hidden until they have files | **Done** |
| 7 | Time blocks in `channel.json`, borrowing shows across channels, approximate 2001 Cartoon Network template | **Done** |
| 8 | Kids / Family / Late Night profiles, per-file rating caps, PIN, time-based switching | **Done** |
| 9 | Offline handling for live channels; library changes appear on the TV live | **Done** |
| 10 | FFmpeg install and "make it play" (remux / audio-only / H.264 re-encode with bwdif, DVD VOB joining, optional loudness) | **Done**, tested with generated interlaced MPEG-2 VOBs, Xvid AVI, H.264+AC-3 and MKV, in unit tests and in the real Library window |
| 11 | Wikimedia Commons adapter; IA scrape API for bulk collection imports | Later |
| 12 | Era mode (1995/1998/2001/2004/2007/2010) built from sourced schedules | Later; needs schedule research per year |
| 13 | Channel logos in banner/guide | Later |

### How it was verified

- `npm test`: 23 tests: 3 conversion tests with real FFmpeg (skipped automatically on a PC
  without FFmpeg) plus 20 unit tests (paths, probe parsing, metadata guessing, library moves/imports,
  IA parsing against real captured responses, downloads against a local server with Range
  support, schedule including blocks across midnight and weekdays, profiles).
- An end-to-end harness ran the real app against a scratch media folder: profile switching,
  hidden empty channels, broadcast channel with no inserted ads, block construction, the
  Library window searching archive.org live (52 Toonami broadcasts), opening an item,
  downloading 3 real files with MD5 verification into a channel and the inbox, duplicate
  detection, assigning a file to a channel and seeing it appear on the TV, and confirming the
  TV page has no access to the Library API.

## 11. Historical schedules

Rebuilding a specific day's schedule needs listings: newspaper TV grids, network press
schedules, and the air dates visible in off-air recordings (CNDump2 file names carry dates).
The app now supports time-of-day and day-of-week **blocks**, so a channel can run e.g.
Toonami weekday afternoons and Cartoon Cartoon Fridays on Friday evenings. The bundled
`2001 Cartoon Network` template is **an approximation from well-known block names, not a
verified listing**, and its `channel.json` says so.
