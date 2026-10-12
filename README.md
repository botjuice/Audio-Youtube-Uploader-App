# Yoosy Joosy

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
`Yoosy Joosy-x.y.z-win-x64.exe` or `Yoosy Joosy-x.y.z-mac-arm64.dmg` / `-x64.dmg`.
FFmpeg is bundled — nothing else to install.

> macOS: the app isn't notarised. First launch: right-click → **Open**, or run
> `xattr -dr com.apple.quarantine "/Applications/Yoosy Joosy.app"`.
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
| **Fixable** | Filename typo with a one-click suggestion (`FINALmuminoon` → `Muminoon`, `ShamsLayl` → `Shams•Layl`, `14x.12.2024` → `14.12.2024`, reversed prayer/surah order) |
| **Needs you** | No prayer name · unknown surah (add the spelling in Settings) · reciter has no Arabic name · no photo · file empty/unreadable · wrong prefix |
| **Skipped** | You excluded it |
| **Uploaded** | Marker present (from this app, a manual mark, or **Sync with YouTube** matching the title on your channel) |

Click a row for the detail panel: rename, override the title, toggle playlists for
just that recording, mark as uploaded / not uploaded, skip, open on YouTube.
Failed attempts keep their error message on the row until the next success.

## Filename format

`{ReciterFolderName}{Prayer}{Surah}•{Surah}-{DD.MM.YYYY}.{m4a|mp3|wav|…}`

- Prefix = folder name with spaces removed (override per reciter if needed)
- Prayer ∈ Fajr, Dhuhr, Asr, Maghrib, Isha, Taraweeh, Qiyam, Tahajjud, Witr (any case)
- Several surahs separated by `•`; 700+ transliteration spellings understood, add your own
- Day/month may be 1 or 2 digits

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
