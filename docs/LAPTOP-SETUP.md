# Sharing your drives from another computer

This sets up Retro TV on the computer that has your videos (for example a laptop), and shares
those videos over the internet for free. Then:

- the Retro TV website plays them on their channels, on any phone, iPad or computer, and
- the Retro TV on your TV computer plays them too.

The computer with the videos does the streaming, so it has to be **on, plugged in and awake** while
people watch. Nothing is uploaded or copied, and your files are never changed.

## 1. Make the setup file (on the TV computer)

In the Retro TV folder, run:

```
npm run pack
```

That makes `RetroTV-setup.zip` (about 1 MB) on the desktop (or give it a place: `npm run pack -- D:\RetroTV-setup.zip`). It has the program and your channel
lineup, but no videos and no PIN. Copy it to the other computer (AnyDesk's file transfer, a USB
stick, or email it to yourself).

## 2. Install it (on the computer with the videos)

1. Install **Node.js** (the "LTS" version) from nodejs.org.
2. Install **FFmpeg**, which measures video lengths: open PowerShell and run
   `winget install Gyan.FFmpeg`
3. Unzip `RetroTV-setup.zip`, for example to `C:\RetroTV`.
4. Double-click **Retro TV Server.cmd**. The first time it downloads what it needs (a few minutes).
   The Library window opens. (`Retro TV.cmd` opens the TV as well, if this computer is a TV too.)

## 3. Link your videos

In the Library window, **Your drives** tab:

1. **Add a folder or drive...** and pick the folder with your shows.
2. Choose a channel for each subfolder (or put everything on one), and who sees new channels.
3. **Use these folders.** Lengths are measured in the background; the tab shows progress.

Folders can stay where they are, on any drive. iPhones and iPads play MP4 and MOV files; others are
counted as "to convert" and only play on computers.

## 4. Share over the internet

In the Library window, **Phone at home** tab:

1. Turn on **Let my phone and iPad play shows from this PC**. When Windows asks about the firewall,
   allow **Private networks**.
2. Optional: turn off **Ask for a passcode** if anyone who has the address may watch.
3. Install **Tailscale** (free, tailscale.com/download) and sign in. Viewers don't need it.
4. Turn on **Share my shows over the internet**. The first time, Tailscale asks you to allow it:
   press **Allow it in Tailscale**, approve, then **Done, try again**.
5. Your address appears, like `https://my-laptop.tail1234.ts.net/`. It stays the same.

## 5. Keep it awake

Settings, System, Power: **Sleep: Never** when plugged in. Control Panel, Power Options, "Choose
what closing the lid does": **Do nothing** when plugged in. To start sharing when the computer
starts, put a shortcut to **Retro TV Server.cmd** in the Startup folder (press Win+R, type
`shell:startup`).

## 6. Watch

- **One device:** open the Retro TV website, then MENU, Settings, **Shows on your PC**, enter the
  address (and the passcode, if it's on).
- **Everyone, automatically:** on the computer that publishes the website, put the address in
  `channels.json` under `settings`:
  `"publicServer": "https://my-laptop.tail1234.ts.net"` (the passcode must be off), then publish
  the website again (`node scripts/deploy-mobile.js`). Every visitor gets the shows.
- **The TV computer:** the same `"publicServer"` setting in its `channels.json` makes its TV play
  them too. It checks every few minutes, so the shows appear and disappear as the other computer
  comes and goes.

## Good to know

- How many people can watch at once depends on that computer's upload speed: standard-definition
  shows need about 1 to 3 Mbps each, HD about 5 to 10.
- Tailscale's free sharing is meant for personal use and has a bandwidth limit they don't publish.
- If the computer is off or asleep, its shows simply leave the channels until it's back.
