# Yoosy Joosy

Automated audio → video → YouTube pipeline for Quran-recitation recordings.

Given an audio file of a recitation, Yoosy Joosy renders a 720p video using
the reciter's photo, uploads it to YouTube with an Arabic-translated title,
and routes the video into whichever playlists you've configured (per reciter,
per prayer, or per surah).

```
Reciters/
└── AbdullahAlMousa/
    ├── photo.jpg
    └── AbdullahAlMousaIshaBaqarah-01.03.2025.mp3
```
↓
> **عبدالله الموسى | سورة البقرة - صلاة العشاء 01.03.2025**
> uploaded to YouTube · added to *Abdullah Al-Mousa*, *Isha*, and *Baqarah* playlists

## Features

- 🖥  **GUI** — colour-coded filename diagnosis, ⚡ auto-fix, live upload progress
- 🎵  **Multi-playlist routing** — per-reciter, per-prayer (Fajr / Maghrib / etc.), per-surah; one upload can land in several playlists at once
- 🌙  **Background watcher** — polls for new audio files and auto-uploads them
- 🚀  **Start on login** — installs an OS-level autostart entry (Windows / macOS / Linux)
- ⚙  **One-time setup wizard** — creates a Google Cloud project, enables the YouTube API, and downloads OAuth credentials for you
- 📝  **700+ surah-name aliases** built in (handles transliteration variants like `thashr` → الحشر, `3ma` → النبأ); add your own from the GUI
- 📋  **Per-file marker system** — uploaded files are skipped automatically on re-runs

## Quick start

```bash
git clone https://github.com/<your-username>/yoosy-joosy
cd yoosy-joosy/script
pip install -r requirements.txt
python make_videos.py --setup    # walks you through Google Cloud + YouTube auth
python gui.py                    # launches the GUI
```

Drop reciter folders alongside `script/` (i.e. inside `yoosy-joosy/`).
The program auto-detects them.

> 📖 Detailed walkthrough: **[script/SETUP.md](script/SETUP.md)**
> 🏗  Architecture & file reference: **[script/README.md](script/README.md)**

## Requirements

| Tool | Why | Install |
|---|---|---|
| Python 3.10+ | runtime | <https://python.org> |
| FFmpeg | video encoding | `choco install ffmpeg` (Windows) / `brew install ffmpeg` (macOS) |
| gcloud CLI | one-time Google Cloud setup | <https://cloud.google.com/sdk/docs/install> |
| YouTube channel | upload target | (you presumably have one) |

The `--setup` wizard handles the YouTube API enablement, OAuth consent screen,
and credentials download — you don't touch the Google Cloud Console manually.

## Filename format

`{ReciterFolderName}{Prayer}{Surah1}•{Surah2}-{DD.MM.YYYY}.{ext}`

The folder name (with spaces removed) becomes the file prefix. Prayers are
`Fajr`, `Dhuhr`, `Asr`, `Maghrib`, `Isha`, `Taraweeh`, `Qiyam`, `Tahajjud`, `Witr`.
Surahs are separated by `•`. Date trails. Filename diagnostics in the GUI catch
typos, bad ordering, missing dates, and unrecognised surahs — most are auto-fixable.

## License

[MIT](LICENSE) — use, modify, fork freely.
