# Yoosy Joosy — Setup walkthrough

Detailed setup. For a feature overview, see **[README.md](README.md)**.

## Where this folder goes

You should have a folder structure like:

```
Wherever-You-Want/
├── script/                       ← this folder
│   ├── gui.py, make_videos.py
│   └── all the .json + .md files
└── (reciter folders go here)
```

Drop `script/` anywhere. Reciter folders go beside it (siblings, not children).

---

## 1. Install system tools (one-time per machine)

### Python 3.10+
- **Windows:** <https://www.python.org/downloads/> — tick **"Add Python to PATH"** during install
- **macOS:** `brew install python` or use the installer above

### FFmpeg
- **Windows:** install [Chocolatey](https://chocolatey.org/install) then `choco install ffmpeg` in an admin PowerShell. Or download from <https://www.gyan.dev/ffmpeg/builds/> ("release essentials"), unzip, add the `bin` folder to PATH.
- **macOS:** `brew install ffmpeg`

### gcloud CLI (only for the one-time Google Cloud setup)
- **Windows:** `winget install Google.CloudSDK` in admin PowerShell, or <https://cloud.google.com/sdk/docs/install>
- **macOS:** `brew install --cask google-cloud-sdk`

Verify everything in a **new** terminal window:

```sh
python --version       # 3.10 or higher
ffmpeg -version        # any recent version
gcloud --version       # any recent version
```

---

## 2. Install Python dependencies

```sh
cd path/to/script
pip install -r requirements.txt
```

This installs `google-api-python-client`, `google-auth-oauthlib`, and `customtkinter`.

---

## 3. Run the one-time setup wizard

```sh
python make_videos.py --setup
```

It walks you through, in order:
1. Verifying gcloud is installed
2. Signing into Google Cloud (browser pops up)
3. Creating a project named `reciter-uploader-XXXXXX`
4. Enabling YouTube Data API v3
5. Configuring the OAuth consent screen (browser opens to the right page)
6. Creating an OAuth Desktop client and downloading `client_secret.json`
7. Verifying the connection by fetching your channel name

When it finishes, `client_secret.json` and `token.json` are sitting in `script/`.
You're authenticated; no further configuration needed before launching the GUI.

---

## 4. Add your reciter folders

Each reciter gets a folder beside `script/`. Inside the folder:

- One image (`.jpg`/`.jpeg`/`.png`/`.webp`) — becomes the video background
- Audio files named like `{ReciterFolderName}{Prayer}{Surah}-{DD.MM.YYYY}.{ext}`

The folder name itself can be anything (spaces are fine). The audio filename
prefix must match the folder name with spaces removed. Example folder
`Abdullah Al Mousa` → filenames start with `AbdullahAlMousa…`

You don't have to write `reciters.json` yourself. The GUI prompts you for the
Arabic name when it sees a new folder.

---

## 5. Launch the GUI

```sh
python gui.py
```

### Page 1 — Connect YouTube
Auto-verifies the saved token and shows your channel name. Click **Continue**.

### Page 2 — File Check
Scans every reciter folder. Each file is colour-coded:
- ✓ **green** — ready to upload
- ⚠ **yellow** — fixable typo (click **Fix** or **⚡ Auto-fix All**)
- ✗ **red** — needs manual input (e.g. missing prayer name) — type a new filename, click **Apply**

For new reciter folders, an inline input asks for the Arabic name. Type and **Save**.

If a folder is missing an image, you get a warning banner — drop a `.jpg` in.

### Page 3 — Upload
Shows pending files (with full Arabic title preview), the daily quota, and a live log.
Click **⬆ Upload N video(s)** to start.

After the batch finishes, the button becomes **↻ Refresh** so you can run another
batch (subject to remaining quota).

---

## 6. Header buttons (any page)

### 🎵 Playlists
Three sections — **Reciters**, **Prayers**, **Surahs**:
- Toggle each playlist on/off without losing the ID
- Paste an ID, or click **Fetch** to pick from your channel's playlists
- One video can land in multiple playlists at once (e.g. an Isha Baqarah video
  → reciter playlist + Isha playlist + Baqarah playlist)
- Reciter rows also let you edit the Arabic name and (advanced) the filename prefix

### ⚙ Settings
- **Upload defaults** — daily limit, privacy (public/unlisted/private), category, tags, description, made-for-kids
- **🌙 Background Mode** — see next section
- **Add surah alias** — when a filename uses an unusual transliteration (e.g.
  `Thashr`), add it here so the program knows the Arabic equivalent
- **Browse aliases** — search 700+ existing aliases, edit any, delete with ✕

---

## 7. Background mode (the watcher)

Settings → 🌙 Background Mode lets you run a watcher that auto-uploads new files
as they appear:

- **Run continuously** — saves the preference; the watcher will start whenever
  you click **▶ Start now** or whenever the OS launches it on login
- **Start on login** — installs an OS-level startup entry:
  - **Windows:** `.bat` in `%APPDATA%\…\Startup\` (uses `pythonw.exe` so no console pops up)
  - **macOS:** LaunchAgent plist in `~/Library/LaunchAgents/`
  - **Linux:** `.desktop` autostart file
- **Check every X minutes** — poll interval (default 30, min 1)
- **▶ Start now / ■ Stop** — control the running watcher process. Stop is graceful:
  if the watcher is mid-upload it'll finish that upload before exiting
- **📋 View log** — last 300 lines from `.watcher.log`

The watcher runs as an **independent process** — closing the GUI does not stop it.
The header shows "🌙 watcher running" while it's active.

---

## CLI alternatives

If you'd rather skip the GUI entirely:

```sh
python make_videos.py --setup        # one-time Google Cloud setup
python make_videos.py --auth         # re-authenticate
python make_videos.py --check        # interactive filename diagnosis
python make_videos.py --dry-run      # encode but don't upload
python make_videos.py --limit 1      # upload at most 1 (good for first test)
python make_videos.py --watch        # run continuously, polling for new files
python make_videos.py                # uploads up to daily_limit from youtube.json
```

---

## How processed files are tracked

After a successful upload, a `<filename>.<ext>.uploaded` marker is written next
to the audio. On the next run (or watcher poll), files with markers are skipped.
To force a re-upload, delete the marker.

The generated `.mp4` is kept too. Re-running after deleting the marker reuses
the existing video — no re-encoding.

---

## Schedule daily runs (alternative to background watcher)

If you'd rather use Windows Task Scheduler instead of the watcher:

1. Open Task Scheduler → Create Basic Task
2. Trigger: Daily at e.g. **9:00 AM** (after the YouTube quota resets at midnight Pacific)
3. Action: Start a program
   - Program: `python`
   - Arguments: `"C:\path\to\Yoosy Joosy\script\make_videos.py"`
   - Start in: `C:\path\to\Yoosy Joosy\script`
4. Save

To upload faster, request a quota increase from Google: <https://support.google.com/youtube/contact/yt_api_form>.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `client_secret.json not found` | Run `python make_videos.py --setup` |
| Token invalid / refresh fails | Delete `token.json` and click Connect again |
| Unrecognised surah | ⚙ Settings → Add Surah Alias, or edit `surahs.json` directly |
| Wrong title | Confirm the audio filename starts with the folder name (spaces removed) |
| Stuck pending file | File Check page — every issue has a suggested fix or manual input |
| Watcher won't stop | Click ■ Stop. If mid-upload it will finish first. Force-kill via Task Manager if truly stuck |
| GUI looks broken / dark theme issues | Update `customtkinter`: `pip install --upgrade customtkinter` |
| `ffmpeg: command not found` | Add ffmpeg's `bin` folder to PATH and reopen your terminal |
| Quota exhausted | Wait until midnight Pacific (≈8 AM UTC) — quotas reset daily |

---

## File reference

| File | Purpose | Edit by |
|---|---|---|
| `make_videos.py` | CLI + watcher | (don't) |
| `gui.py` | GUI front-end | (don't) |
| `surahs.json` | Surah name → Arabic translations + aliases | ⚙ Settings or directly |
| `reciters.json` | Per-reciter config | 🎵 Playlists or directly |
| `playlists.json` | Per-prayer / per-surah playlist assignments | 🎵 Playlists or directly |
| `youtube.json` | Upload defaults | ⚙ Settings or directly |
| `background.json` | Watcher prefs | ⚙ Settings or directly |
| `client_secret.json` | OAuth credentials | from `--setup` (don't commit) |
| `token.json` | OAuth token | auto-managed (don't commit) |
| `.quota.json` | Today's upload count | auto-managed |
| `.watcher.pid` | Running watcher's PID | auto-managed |
| `.watcher.log` | Watcher activity log | auto-managed |
| `<audio>.<ext>.uploaded` | Per-file upload marker | auto-managed |

Back to **[README.md](README.md)**.
