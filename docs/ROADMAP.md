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
| Episode catalog (shows, seasons, episodes, sources) | Missing | |
| Missing-episode tracking, external metadata (TVmaze/TMDB) | Missing | |
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

## Milestone 2: faster, steadier tuning

- Use the health records before tuning: skip straight to a stand-in for a resting source
  (done), and warm the next/previous channel's lightweight metadata only.
- Live YouTube: refresh the stream ID in the background when a check finds it ended, so tuning
  doesn't wait.
- Audit for overlapping audio when surfing quickly between webview channels.
- Tests for the tune token and cancellation paths.

## Milestone 3: episode catalog (Phase 2)

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

## Milestone 4: discovery (Phase 3)

- A provider capability model (search, metadata, embed, download) over `lib/sources/`.
- Broader Archive searches by year, network and kind, ranking full-length recordings over clips.
- Complete-broadcast detection (length, title cues, multiple episodes) with a manual flag.
- "Channel needs more programming" suggestions from catalog gaps, which only report sources
  that actually answered.

## Milestone 5: era mode (Phase 4)

- A year selector (1980 to 2015 first). A per-network history table (launch and rebrand dates,
  blocks such as Toonami 1997–2008) sourced and cited, not guessed.
- Eligibility by year: era mode prefers programs that were airing in the selected year (from
  the catalog's premiere and end dates). Pre-1980 shows stay allowed (the user's call, October
  2026); there is no default exclusion.
- Era simulation (a plausible lineup) and historical reconstruction (imported listings with
  provenance; unknowns marked as approximate) as two clearly labelled modes.

## Milestone 6: presentation (Phase 5)

- Break clips tagged by network, year range and kind. Schedule-aware selection with repeat
  avoidance. IDs at intervals.
- Loudness: measure files once with FFmpeg (`ebur128`) and apply a playback gain on the PC and
  phone video elements. Embedded web players can't be levelled; the app will say so.
- Favorites, recent channels, per-channel history and rerun spacing.

## Milestone 7: consistency (Phase 6)

- The home server publishes the real schedule (`Schedule.listings`) and catalog metadata, so the
  phone never computes a different one.
- Performance pass and regression tests across PC and phone.
