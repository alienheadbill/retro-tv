# Retro TV roadmap

Where the "television time machine" plan stands, what exists to build on, and the next
milestones in order. Each milestone is small, tested on its own, and leaves the app working.

## What exists today (audited October 2026)

| Area | Status | Where |
|---|---|---|
| Wall-clock scheduling: deterministic loop since 2000-01-01, join in progress, time blocks, borrowed shows, grouped/history order | Working, tested | `src/schedule.js` |
| Profiles, rating caps, profile schedule | Working (not to be changed here) | `src/profiles.js` |
| **Playback health and recovery** (milestone 1, below) | **New, working, tested** | `src/health.js`, `src/app.js`, `mobile/tv.js` |
| **Channel health checks and Library tab** | **New, working, tested** | `lib/channel-checks.js`, `main.js`, `manager/` |
| Internet Archive search, item view, downloads with MD5, resume | Working, tested | `lib/sources/`, `lib/downloads.js` |
| FFmpeg probe, remux/convert, loudness (`loudnorm`) on conversion | Working, tested | `lib/probe.js`, `lib/convert.js` |
| Library index with editable metadata (show, season, episode, network, year, air date, broadcast) | Working | `lib/library.js`, `lib/meta.js` |
| YouTube playlists/channels as scheduled channels, live streams, framing crop, dedupe, English filter | Working, tested | `lib/youtube-channels.js`, `lib/framing.js` |
| Linked folders on other drives, home server, internet sharing | Working, tested (not yet run on the laptop) | `lib/linked.js`, `lib/home-server.js`, `lib/funnel.js` |
| Phone app sharing the same schedule, profiles and health code | Working | `mobile/`, `scripts/build-mobile.js` |
| Episode catalog: have / missing / twice per show, from TVmaze, with corrections | New, tested (first slice) | `lib/catalog.js`, `lib/episode-match.js`, `lib/sources/tvmaze.js` |
| Catalog sources, alternates for recovery, TMDB | Missing | |
| Era/year mode, historical schedules, provenance | Missing | |
| Era-aware commercials and bumpers | Missing (breaks are random from a pool) | |
| Playback loudness levelling | Only when converting a file | |

## Milestone 1: playback health and recovery (done)

- One health record per source (file, YouTube video, PC-shared file, live channel): last
  success, last failure and reason, failures in a row, stalls, start time.
  Healthy / degraded / unavailable / unverified, with exponential rest (1 min to 6 h).
- Recovery that never reshuffles the schedule. It retries once, then tries an alternate source
  (the `alternates` field, ready for the catalog), then a deterministic stand-in for the rest of
  the slot (same show first), then a standby card. Before, a failed video was dropped for the
  session and the whole channel's timeline shifted.
- Stall and start-timeout detection for local, PC-shared and YouTube playback. Live pages get
  one reload before counting as failed. On the phone, the first-tap wait doesn't count.
- What aired is logged, including stand-ins and their reasons. The banner and guide say
  "stand-in".
- Channel health tab with on-demand provider checks and the TV's own reports.
- Tests: `tests/health.test.js`, `tests/channel-checks.test.js`.

Needs checking by hand (it can't run in this environment):

- The PC TV with a deliberately broken file: retry, then stand-in, then the schedule resumes.
  The phone app was checked end to end in a browser.
- The Library's Channel health tab inside the real app. Its layout was checked with sample data.

## Milestone 2: one TV for the PC and the phone (done)

The phone app already shares the PC's channel list (`channels.json`, built in by
`scripts/build-mobile.js`) and its schedule, health, profile and guide code. The two TV screens,
`src/app.js` and `mobile/tv.js`, are still separate, so every change to tuning, the banner,
recovery or remote buttons is made twice.

1. **Shared core** (`src/tv-core.js`). It covers:
   - channel state, tuning and surfing, profiles
   - schedule playback and recovery, stand-ins and the what-aired log
   - banner, OSD, guide data, ORDER, health reporting

   Each step moves one area and is checked on both TVs before the next.
2. **Two small players.** The PC player holds Electron webviews (Pluto, Vaughn, the YouTube watch
   page), files and the keyboard. The web player holds iframes, the YouTube IFrame API,
   on-device videos, PC-shared videos and touch.
3. **Publishing from the Library.** An "Update the phone app" button, so a channel change on the
   PC reaches the phone in one click instead of a separate script.
4. **Tests** that run the same channel and recovery scenarios through both players.

Done (October 2026): `src/tv-core.js` holds all of the above. `src/app.js` (PC) and `mobile/tv.js`
(phone) are now only their players and controls. The phone gained stall detection and the
what-aired log on the way. The Library has **Publish the website** (Phone at home tab).
`npm run test:tv` drives the real PC TV hidden (15 checks with `--online`); the phone was checked
end to end in a phone-sized browser with the same missing-episode scenario and its remote buttons.

## Milestone 3: faster, steadier tuning (done)

- **Surfing:** the channel number and static appear at once, but a channel's player only starts
  after 0.35 seconds on it, which the static covers. Five quick presses start one player, not
  five, and the channels flicked past aren't counted as failures. This is in `src/tv-core.js`, so
  both TVs behave the same.
- **Live YouTube lookups:** the TV checks every live channel's status each minute. YouTube live
  channels used to fetch YouTube's page every time, which was 30 fetches a minute and enough to
  trigger YouTube's unusual-traffic block. They now answer from a lookup made within the last
  20 minutes, and look again only when it's older or the stream the TV had didn't work. In that
  case the PC TV retunes to the new stream.
- **Start times:** each source's start time feeds a typical start time per channel, shown in
  Channel health ("starts in ~1.2 s").
- **Tests:** `npm run test:tv` checks rapid surfing (one player started, no false failures). A
  unit test covers the live lookup cache. The phone was checked the same way in a browser.
- **Still open:** warming the next channel ahead of time. It isn't needed for scheduled channels,
  which are measured in the background, and live sites are too heavy to preload.

## Milestone 4: episode catalog (Phase 2)

**First slice done (October 2026).** `tests/catalog.test.js` covers the matcher and the
have/missing/twice report against a stand-in TVmaze. The Shows tab was checked in a browser
against the real TVmaze with sample file names (Dexter's Laboratory, Ed Edd n Eddy, Rugrats,
Bakugan, a full broadcast, unknown files), including a "Not an episode" correction. It hasn't
been run on the real library yet.

- `lib/episode-match.js`: show, season, episode and title from file names, with confidence.
- `lib/sources/tvmaze.js`: TVmaze search and episode lists, kept a week (a month for ended shows),
  and paced requests.
- `lib/catalog.js`: have, missing, twice and not placed per show, plus complete broadcasts and
  files with no show name. Corrections are kept in `media/.retrotv/catalog.json`.
- Library: a **Shows** tab with a per-season episode grid, missing and doubled-up lists,
  "Find the right show", and "Put here" / "Not an episode" for files it couldn't place.
- Storage stays JSON for now. Checking for `node:sqlite` in Electron 45 is still to do.

The plan:

- Storage: evaluate Node's built-in `node:sqlite` against Electron 45's Node version. Fall back to
  the existing JSON index if it isn't available, rather than adding a native module.
- Model: show, season, episode, special, broadcast recording, break clip (commercial, bumper,
  ID, promo), file, source (local, linked drive, Archive item, YouTube video), channel link,
  historical airing (with provenance). One episode can have many files and sources; one file
  can hold many episodes (broadcasts).
- Filename matcher: `S02E04`, `Season 1 Episode 3`, `2x04`, "Full Broadcast - 2003", with
  confidence and manual correction. It only fills in what it can match.
- TVmaze (free, no key) for show, season and episode lists, premiere dates and networks.
  TMDB is optional, with the user's own key. Both are cached and rate-limited.
- Missing and duplicate reports per show. Nothing is ever deleted automatically.
- Feeds `alternates` into recovery.

## Milestone 5: discovery (Phase 3)

- A provider capability model (search, metadata, embed, download) over `lib/sources/`.
- Broader Archive searches by year, network and kind, ranking full-length recordings over clips.
- Complete-broadcast detection (length, title cues, multiple episodes) with a manual flag.
- "Channel needs more programming" suggestions from catalog gaps, which only report sources
  that actually answered.

## Milestone 6: era mode (Phase 4)

- A year selector (1980 to 2015 first). A per-network history table (launch and rebrand dates,
  blocks such as Toonami 1997–2008) sourced and cited, not guessed.
- Eligibility by year: era mode prefers programs that were airing in the selected year (from
  the catalog's premiere and end dates). Pre-1980 shows stay allowed (the user's call, October
  2026); there is no default exclusion.
- Era simulation (a plausible lineup) and historical reconstruction (imported listings with
  provenance; unknowns marked as approximate) as two clearly labelled modes.

## Milestone 7: presentation (Phase 5)

- Break clips tagged by network, year range and kind. Schedule-aware selection with repeat
  avoidance. IDs at intervals.
- Loudness: measure files once with FFmpeg (`ebur128`) and apply a playback gain on the PC and
  phone video elements. Embedded web players can't be levelled; the app will say so.
- Favorites, recent channels, per-channel history and rerun spacing.

## Milestone 8: consistency (Phase 6)

- The home server publishes the real schedule (`Schedule.listings`) and catalog metadata, so the
  phone never computes a different one.
- Performance pass and regression tests across PC and phone.
