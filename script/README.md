# Yoosy Joosy

Automated audio → video → YouTube pipeline for reciter recordings.

Drop reciter folders next to this `script/` directory. The program scans them,
encodes each audio into a 720p video using the reciter's photo, uploads to
YouTube with an Arabic-translated title, and adds the result to whichever
playlists you configured (per-reciter, per-prayer, per-surah).

## What you get

- **GUI** (`gui.py`) — connect, fix filename issues, configure playlists, upload
- **CLI** (`make_videos.py`) — same pipeline scriptable from the terminal
- **Background watcher** — polls for new files and auto-uploads, can start on login
- **One-time setup wizard** that creates a Google Cloud project + downloads OAuth credentials for you

## Quick start

1. Install Python 3.10+, FFmpeg, and gcloud CLI on Windows (one-time per machine).
2. `pip install -r requirements.txt`
3. `python make_videos.py --setup` — walks you through Google Cloud + YouTube auth
4. `python gui.py` — launch the GUI
5. In the GUI: Connect → Check files → Upload

For full step-by-step instructions, see **[SETUP.md](SETUP.md)**.

## Folder layout (after first run)

```
Yoosy Joosy/                     ← any name you like
├── script/                      ← this folder, the whole program
│   ├── gui.py
│   ├── make_videos.py
│   ├── README.md                ← you're reading it
│   ├── SETUP.md                 ← detailed setup walkthrough
│   ├── surahs.json              ← all 114 surahs + transliteration aliases
│   ├── reciters.json            ← per-reciter config (auto-populated)
│   ├── playlists.json           ← per-prayer & per-surah playlist assignments
│   ├── youtube.json             ← upload defaults
│   ├── background.json          ← watcher prefs (auto-created)
│   ├── requirements.txt
│   ├── client_secret.json       ← from --setup wizard
│   └── token.json               ← OAuth token (auto-created)
│
├── ReciterOneFolder/            ← any number of reciter folders
│   ├── photo.jpg                ← any image becomes the video background
│   └── ReciterOneFolderFajrBaqarah-01.03.2025.mp3
│
└── ReciterTwoFolder/
    └── ...
```

The `script/` folder is portable — drop it anywhere and it auto-detects sibling
reciter folders. No path config needed.

## Filename format

`{ReciterFolderName}{Prayer}{Surah1}•{Surah2}-{DD.MM.YYYY}.{ext}`

- `ReciterFolderName` — must match the folder name (spaces removed)
- `Prayer` — `Fajr`, `Dhuhr`, `Asr`, `Maghrib`, `Isha`, `Taraweeh`, `Qiyam`, `Tahajjud`, or `Witr`
- `Surah` separators — `•` between multiple surahs
- Date — `DD.MM.YYYY`

Example: `AbdullahAlMousaIshaAhzab•Munafiqoon-01.03.2025.mp3`
→ Title: `عبدالله الموسى | سورة الأحزاب و المنافقون - صلاة العشاء 01.03.2025`

The GUI's File Check page diagnoses any filename that doesn't match and offers
auto-fix or manual rename.

## Features

| Feature | Where |
|---|---|
| Connect / re-authenticate YouTube | Auth page (auto-verifies on launch) |
| Diagnose & fix filenames | Check page (per-file ⚡ Auto-fix) |
| Upload + Arabic title + playlist add | Upload page |
| Per-reciter playlist | 🎵 Playlists button |
| Per-prayer playlist (Fajr/Maghrib/etc.) | 🎵 Playlists button |
| Per-surah playlist (e.g. all Baqarah) | 🎵 Playlists button |
| Edit upload defaults (privacy, tags, description) | ⚙ Settings button |
| Add / edit / delete surah aliases | ⚙ Settings button |
| Run continuously, auto-upload new files | ⚙ Settings → Background Mode |
| Start on system login | ⚙ Settings → Background Mode |
| Edit reciter Arabic name + prefix | 🎵 Playlists button |

## Troubleshooting

See **[SETUP.md § Troubleshooting](SETUP.md#troubleshooting)**.

## License

Personal use. No warranty.
