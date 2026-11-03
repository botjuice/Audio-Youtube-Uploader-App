# YouTube Quran Uploader

Desktop app (Windows · macOS) that turns a folder of Quran-recitation audio into
YouTube videos — rendered with the reciter's photo, titled in Arabic, sorted into
the right playlists — and can keep doing it on its own as new recordings land.

```
Recordings/
└── Abdullah Al Mousa/
    ├── photo.jpg
    └── AbdullahAlMousaIshaBaqarah-01.03.2025.m4a
```
↓ one click (or none, with auto-upload on)
> **عبدالله الموسى | سورة البقرة - صلاة العشاء 01.03.2025**
> on YouTube · in the *Abdullah Al-Mousa*, *Isha* and *Baqarah* playlists

## Download

Grab the installer for your OS from **[Releases](../../releases/latest)**:
`YouTube Quran Uploader-x.y.z-win-x64.exe` or `YouTube Quran Uploader-x.y.z-mac-arm64.dmg` / `-x64.dmg`.
FFmpeg is bundled — nothing else to install.

> macOS: the app isn't notarised. First launch: right-click → **Open**, or run
> `xattr -dr com.apple.quarantine "/Applications/YouTube Quran Uploader.app"`.
> Windows: SmartScreen may warn on first run → **More info → Run anyway**.

## First run (≈10 minutes, once)

1. **Choose your library folder** — the folder that contains one sub-folder per reciter.
2. **Settings → Google / YouTube** — follow the 5-step guide to create a free OAuth client in Google Cloud, pick the downloaded `client_secret.json`, click **Connect Google**. Full walkthrough in **[SETUP.md](SETUP.md)**.
3. **Reciters** — type each reciter's Arabic name (used in every title). Pick the photo if there's more than one.
4. **Playlists** — create playlists from the app or refresh your existing ones, then add rules: *Reciter is …*, *Prayer is …*, *Surah includes …*, *Filename contains …*.
5. **Library** — fix any flagged filenames (most are one-click), tick what you want, **Upload**.

Turn on **Settings → Auto-upload new files** and the app watches the folder, uploads
new recordings within the daily limit, and can start hidden when you log in.

## Updates

The app checks GitHub Releases 30 s after launch and every 6 hours, downloads new
versions in the background and verifies them (SHA-512). It **never restarts during
an upload**: with the window open you get a "Restart now" card in the sidebar; when the
app is hidden in the tray and idle it updates itself (toggle in Settings → About).
Existing users on 2.0.x must install 2.1.0 by hand once; after that it's automatic.

Shipping an update is one command from the repo:

```bash
npm run release -- patch     # or minor / major / 2.3.4
```

It bumps the version, runs typecheck + tests, commits, tags `vX.Y.Z`, pushes, and
GitHub Actions publishes the Windows/macOS installers plus the update feed
(`latest.yml`, `latest-mac.yml`). Users pick it up within 6 hours.

## What the Library tells you

Every recording has a status and, when it isn't uploading, the exact reason:

| Status | Meaning |
|---|---|
| **Ready** | Parses cleanly, title generated, photo found — will upload |
| **Rendered** | MP4 already produced, upload pending |
| **Fixable** | Unrecognised fragment or dirty date with a one-click rename (`FINALmuminoon` → `Muminoon`, `14x.12.2024` → `14.12.2024`) |
| **Needs you** | No date / prayer / surah · unknown fragment (teach it as surah, keyword or reciter) · reciter has no Arabic name · no photo · file empty/unreadable · not in any reciter folder |
| **Skipped** | You excluded it |
| **Uploaded** | Marker present (from this app, a manual mark, or **Sync with YouTube** matching the title on your channel) |

Click a row for the detail panel: rename, override the title, toggle playlists for
just that recording, mark as uploaded / not uploaded, skip, open on YouTube.
Failed attempts keep their error message on the row until the next success.

## Filename format

The app reads names as a **vocabulary**, not a fixed pattern. Any order, separators optional:

| Part | Recognised as | Examples |
|---|---|---|
| Date | `D.M.YYYY` (junk tolerated: `14x.12.2024`) | `01.03.2025`, `1.3.2025` |
| Prayer | one of Fajr · Dhuhr · Asr · Maghrib · Isha · Taraweeh · Qiyam · Tahajjud · Witr | `Isha`, `fajr` |
| Reciter | any reciter folder name or alias (optional — the folder is the default) | `AbdullahAlMousa`, `Mousa` |
| Surah | 400+ spellings; several surahs may be glued or `•`-separated | `Ahzab•Munafiqoon`, `ShamsLayl` |
| Keyword | anything you register in **Playlists → Keywords** | `Final`, `Outside`, `#ramadan` |

`IshaMulk-01.03.2025.m4a` inside a reciter folder is enough. Whatever is left over is shown
as *Needs attention* with a one-click **Remove**, or you can tell the app it's a surah
spelling, a keyword, or a reciter — it learns instead of deleting.

**Auto-filing:** a recording whose name contains a reciter is moved into that reciter's
folder on every scan (sidecars and state travel with it, never overwrites). Drop files at
the library root or in the wrong folder and they sort themselves.


## Where things live

| What | Where |
|---|---|
| Upload markers | `<recording>.uploaded` next to each audio file (so they survive moving the folder) |
| Rendered videos | `<recording>.mp4` next to the audio (reused, never re-encoded) |
| Library config: reciters, rules, spellings, overrides, quota | `<library>/.yoosyjoosy/*.json` |
| Google credentials & token | OS keychain-encrypted in the app's user-data folder — never inside the library |
| Activity log | `<library>/.yoosyjoosy/activity.log` |

## Develop

```bash
npm install
npm run dev        # Electron + Vite with HMR
npm test           # core parsing/rules/quota + scanner + real FFmpeg encode
npm run typecheck
npm run dist:mac   # or dist:win — installers in dist/
```

Stack: Electron 44 · React 19 · TypeScript · Vite 7 · Tailwind 4 · `google-auth-library` · `ffmpeg-static`.
Core logic (`src/core`) is dependency-free and unit-tested; `src/main` is the Node side (scanner, encoder, YouTube, watcher); `src/renderer` is the UI.

Releases are built by GitHub Actions on every `v*` tag (`.github/workflows/release.yml`); use `npm run release` rather than tagging by hand so the version in `package.json` always matches the tag.

## License

[MIT](LICENSE)
