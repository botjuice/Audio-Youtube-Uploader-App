"""
Generates videos from audio + reciter image, uploads to YouTube, adds to playlist.

Usage:
    python make_videos.py --setup      # first-time: create Google Cloud project + connect YouTube
    python make_videos.py --auth       # re-authenticate if token expires
    python make_videos.py --check      # scan for filename issues and interactively rename
    python make_videos.py --dry-run    # encode videos but skip upload
    python make_videos.py --limit 1    # process at most 1 (good for testing)
    python make_videos.py              # process up to daily_limit from youtube.json
"""

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).parent          # .../script/
WORK_DIR = ROOT.parent                # .../Yoosy Joosy/  — where reciter folders live
RECITERS_CONFIG = ROOT / "reciters.json"
SURAHS_FILE = ROOT / "surahs.json"
YOUTUBE_CONFIG = ROOT / "youtube.json"
TOKEN_FILE = ROOT / "token.json"
QUOTA_FILE = ROOT / ".quota.json"
PLAYLISTS_FILE = ROOT / "playlists.json"
BACKGROUND_CONFIG = ROOT / "background.json"
WATCHER_PID_FILE  = ROOT / ".watcher.pid"
WATCHER_LOG_FILE  = ROOT / ".watcher.log"

SCOPES = [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube",
]
AUDIO_EXTS = (".mp3", ".m4a", ".wav", ".aac", ".ogg", ".flac")

PRAYER_AR = {
    "Fajr": "الفجر",
    "Dhuhr": "الظهر",
    "Asr": "العصر",
    "Maghrib": "المغرب",
    "Isha": "العشاء",
    "Taraweeh": "التراويح",
    "Qiyam": "القيام",
    "Tahajjud": "التهجد",
    "Witr": "الوتر",
}
# Case-insensitive prayer lookup: lowercase key → canonical key
PRAYER_LOWER = {k.lower(): k for k in PRAYER_AR}
PRAYERS_RE = "|".join(PRAYER_AR.keys())

# Accepts 1–2 digit day/month; normalised to DD.MM.YYYY on parse
FILENAME_RE = re.compile(
    rf"^(?P<prayer>{PRAYERS_RE})(?P<surahs>.+?)-(?P<date>\d{{1,2}}\.\d{{1,2}}\.\d{{4}})$",
    re.IGNORECASE,
)
DATE_LOOSE_RE = re.compile(r"\d{1,2}\.\d{1,2}\.\d{4}$")
DATE_DIRTY_RE = re.compile(r"[\d\w]+\.[\d\w]+\.\d{4}$")  # date with non-digit chars like 14x


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_reciters(reciters):
    with open(RECITERS_CONFIG, "w", encoding="utf-8") as f:
        json.dump(reciters, f, ensure_ascii=False, indent=2)


def load_playlists():
    if PLAYLISTS_FILE.exists():
        return load_json(PLAYLISTS_FILE)
    return {"prayers": {}, "surahs": {}}


def save_playlists(data):
    with open(PLAYLISTS_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def save_youtube_config(cfg):
    with open(YOUTUBE_CONFIG, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def save_surahs(surahs_dict):
    with open(SURAHS_FILE, "w", encoding="utf-8") as f:
        json.dump(surahs_dict, f, ensure_ascii=False, indent=2)


# ---------------------------------------------------------------------------
# Background mode — polling watcher + OS autostart
# ---------------------------------------------------------------------------

DEFAULT_BG_CONFIG = {
    "enabled": False,
    "start_on_login": False,
    "check_interval_minutes": 30,
}


def load_background_config():
    if BACKGROUND_CONFIG.exists():
        data = load_json(BACKGROUND_CONFIG)
        return {**DEFAULT_BG_CONFIG, **data}
    return dict(DEFAULT_BG_CONFIG)


def save_background_config(cfg):
    with open(BACKGROUND_CONFIG, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def _is_pid_alive(pid):
    """Cross-platform PID liveness check (signal 0 = no-op)."""
    try:
        import os as _os
        _os.kill(pid, 0)
        return True
    except (OSError, ProcessLookupError, PermissionError):
        return False


def watcher_pid():
    """Return PID of running watcher process, or None if not running."""
    if not WATCHER_PID_FILE.exists():
        return None
    try:
        pid = int(WATCHER_PID_FILE.read_text().strip())
    except (ValueError, OSError):
        WATCHER_PID_FILE.unlink(missing_ok=True)
        return None
    if _is_pid_alive(pid):
        return pid
    # Stale PID from a crashed watcher — clean up
    WATCHER_PID_FILE.unlink(missing_ok=True)
    return None


def watcher_log(msg):
    """Append a timestamped line to the watcher log (size-bounded)."""
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}]  {msg}\n"
    try:
        with open(WATCHER_LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line)
        # Truncate to last ~2000 lines if file gets large (>500KB)
        if WATCHER_LOG_FILE.stat().st_size > 500_000:
            tail = WATCHER_LOG_FILE.read_text(encoding="utf-8").splitlines()[-2000:]
            WATCHER_LOG_FILE.write_text("\n".join(tail) + "\n", encoding="utf-8")
    except OSError:
        pass


def read_watcher_log(last_n=200):
    """Return the last `last_n` lines of the watcher log as a list."""
    if not WATCHER_LOG_FILE.exists():
        return []
    try:
        return WATCHER_LOG_FILE.read_text(encoding="utf-8").splitlines()[-last_n:]
    except OSError:
        return []


# ── Autostart entries (Windows / macOS / Linux) ──────────────────────────────

def _autostart_path():
    """Where to put the OS-level autostart entry. Returns Path or None if unsupported."""
    home = Path.home()
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA", home)) / \
               "Microsoft/Windows/Start Menu/Programs/Startup/YoosyJoosyWatcher.bat"
    if sys.platform == "darwin":
        return home / "Library/LaunchAgents/com.yoosyjoosy.watcher.plist"
    # Linux/BSD
    return home / ".config/autostart/yoosyjoosy-watcher.desktop"


def is_autostart_installed():
    p = _autostart_path()
    return p is not None and p.exists()


def _windows_pythonw():
    """Prefer pythonw.exe (no console) over python.exe for Windows autostart."""
    exe = Path(sys.executable)
    candidate = exe.parent / "pythonw.exe"
    return candidate if candidate.exists() else exe


def install_autostart():
    """Register the watcher to run automatically when the user logs in."""
    p = _autostart_path()
    if p is None:
        raise RuntimeError(f"Autostart not supported on platform: {sys.platform}")
    p.parent.mkdir(parents=True, exist_ok=True)

    script = Path(__file__).resolve()

    if sys.platform == "win32":
        pyexe = _windows_pythonw()
        # Quotes around paths handle spaces (e.g. "Yoosy Joosy")
        content = (
            "@echo off\r\n"
            f'start "" "{pyexe}" "{script}" --watch\r\n'
        )
        p.write_text(content, encoding="utf-8")

    elif sys.platform == "darwin":
        plist = (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
            '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
            '<plist version="1.0">\n'
            '<dict>\n'
            '    <key>Label</key>\n'
            '    <string>com.yoosyjoosy.watcher</string>\n'
            '    <key>ProgramArguments</key>\n'
            '    <array>\n'
            f'        <string>{sys.executable}</string>\n'
            f'        <string>{script}</string>\n'
            '        <string>--watch</string>\n'
            '    </array>\n'
            '    <key>RunAtLoad</key>\n'
            '    <true/>\n'
            '    <key>KeepAlive</key>\n'
            '    <true/>\n'
            f'    <key>StandardOutPath</key>\n'
            f'    <string>{WATCHER_LOG_FILE}</string>\n'
            f'    <key>StandardErrorPath</key>\n'
            f'    <string>{WATCHER_LOG_FILE}</string>\n'
            '</dict>\n'
            '</plist>\n'
        )
        p.write_text(plist, encoding="utf-8")
        # Reload so it takes effect immediately (best-effort)
        subprocess.run(["launchctl", "unload", str(p)], capture_output=True, check=False)
        subprocess.run(["launchctl", "load", str(p)], capture_output=True, check=False)

    else:  # Linux/BSD
        content = (
            "[Desktop Entry]\n"
            "Type=Application\n"
            "Name=Yoosy Joosy Watcher\n"
            f"Exec={sys.executable} {script} --watch\n"
            "X-GNOME-Autostart-enabled=true\n"
            "NoDisplay=true\n"
        )
        p.write_text(content, encoding="utf-8")
        try:
            p.chmod(0o755)
        except OSError:
            pass


def uninstall_autostart():
    p = _autostart_path()
    if p is None or not p.exists():
        return
    if sys.platform == "darwin":
        subprocess.run(["launchctl", "unload", str(p)], capture_output=True, check=False)
    p.unlink(missing_ok=True)


# ── Watcher loop ─────────────────────────────────────────────────────────────

def run_watcher():
    """
    Polling loop: every N minutes scan reciter folders for new audio,
    encode + upload up to remaining daily quota, then sleep.

    Reloads config on every iteration so GUI edits take effect without restart.
    """
    import os as _os
    import time

    # Atomic create-and-claim — defends against two watchers spawned in parallel.
    # O_EXCL fails if the file already exists, eliminating the check-then-write race.
    try:
        fd = _os.open(str(WATCHER_PID_FILE), _os.O_WRONLY | _os.O_CREAT | _os.O_EXCL, 0o644)
    except FileExistsError:
        # File exists — but it might be stale from a crashed watcher.
        # watcher_pid() validates liveness and cleans stale files itself.
        if watcher_pid() is not None:
            watcher_log("Refused to start: another watcher is already running.")
            return
        # Stale file was just cleaned up; retry once.
        try:
            fd = _os.open(str(WATCHER_PID_FILE), _os.O_WRONLY | _os.O_CREAT | _os.O_EXCL, 0o644)
        except FileExistsError:
            watcher_log("Refused to start: PID file race lost.")
            return
    with _os.fdopen(fd, "w") as f:
        f.write(str(_os.getpid()))

    watcher_log("─── Watcher started ───")

    # Single try/finally so the PID file is ALWAYS cleaned up, even if auth
    # fails before we enter the polling loop.
    try:
        try:
            from googleapiclient.discovery import build
            creds = get_credentials({}, interactive=False) if TOKEN_FILE.exists() else None
            if creds is None:
                watcher_log("✗ No valid YouTube token. Run --auth (or open the GUI) first.")
                return
        except Exception as e:
            watcher_log(f"✗ Auth failed: {e}")
            return

        while True:
            try:
                bg_cfg      = load_background_config()
                interval    = max(60, int(bg_cfg.get("check_interval_minutes", 30)) * 60)

                # Refresh config every poll so GUI edits propagate
                yt_cfg      = load_json(YOUTUBE_CONFIG) if YOUTUBE_CONFIG.exists() else {}
                reciters    = load_json(RECITERS_CONFIG) if RECITERS_CONFIG.exists() else {}
                surahs_dict = load_json(SURAHS_FILE)    if SURAHS_FILE.exists()    else {}
                playlists   = load_playlists()
                # Coerce — protects against strings creeping in via hand-edited JSON
                try:
                    daily_limit = int(yt_cfg.get("daily_limit", 6))
                except (TypeError, ValueError):
                    daily_limit = 6

                # Check if mode was disabled — exit cleanly if so
                if not bg_cfg.get("enabled", False):
                    watcher_log("Background mode disabled — stopping watcher.")
                    return

                todo = collect_work(reciters, surahs_dict)
                used = quota_used_today()
                remaining = max(0, daily_limit - used)

                if not todo:
                    watcher_log(f"No pending files.  (quota {used}/{daily_limit})")
                elif remaining == 0:
                    watcher_log(f"{len(todo)} pending but daily quota reached. Will retry later.")
                else:
                    batch = todo[:remaining]
                    watcher_log(f"Found {len(todo)} pending — uploading {len(batch)} now.")

                    # Reauth each pass (token may have refreshed)
                    creds = get_credentials(yt_cfg, interactive=False)
                    youtube = build("youtube", "v3", credentials=creds)

                    for item in batch:
                        audio = item["audio"]
                        try:
                            title = build_title(item["config"]["name_ar"], item["parsed"], surahs_dict)
                            video_path = audio.with_suffix(".mp4")

                            if not video_path.exists():
                                watcher_log(f"  encoding  {audio.name}")
                                make_video(audio, item["image"], video_path)

                            watcher_log(f"  uploading  {title}")
                            video_id = upload_video(youtube, video_path, title, yt_cfg)
                            watcher_log(f"    ✓ youtu.be/{video_id}")

                            # Marker BEFORE playlists — see fix in main()
                            item["marker"].write_text(json.dumps({
                                "video_id":    video_id,
                                "title":       title,
                                "uploaded_at": datetime.now(timezone.utc).isoformat(),
                            }, ensure_ascii=False, indent=2))
                            record_quota_use()

                            for pid in get_playlists_for_item(item, playlists):
                                try:
                                    add_to_playlist(youtube, video_id, pid)
                                    watcher_log(f"    → playlist {pid}")
                                except Exception as pe:
                                    watcher_log(f"    ✗ playlist {pid}: {pe}")
                        except Exception as e:
                            watcher_log(f"  ✗ {audio.name}: {e}")
                            if "quota" in str(e).lower():
                                watcher_log("Quota exhausted — stopping this pass.")
                                break
            except Exception as e:
                watcher_log(f"✗ Poll error: {e}")

            # Sleep in 5s chunks so PID-file removal can stop us within a few seconds
            slept = 0
            while slept < interval:
                time.sleep(min(5, interval - slept))
                slept += 5
                # Allow external stop: if PID file was deleted, exit
                if not WATCHER_PID_FILE.exists():
                    watcher_log("PID file removed — stopping watcher.")
                    return
    finally:
        WATCHER_PID_FILE.unlink(missing_ok=True)
        watcher_log("─── Watcher stopped ───")


def normalise_date(raw):
    """'5.1.2025' → '05.01.2025'"""
    parts = raw.split(".")
    return f"{int(parts[0]):02d}.{int(parts[1]):02d}.{parts[2]}"


def parse_filename(audio_path, prefix):
    stem = audio_path.stem
    if not stem.lower().startswith(prefix.lower()):
        return None
    rest = stem[len(prefix):]
    m = FILENAME_RE.match(rest)
    if not m:
        return None
    prayer_canonical = PRAYER_LOWER[m["prayer"].lower()]
    surahs = [s for s in m["surahs"].split("•") if s]
    return {
        "prayer": prayer_canonical,
        "surahs": surahs,
        "date": normalise_date(m["date"]),
    }


def translate_surah(name, surahs_dict):
    key = re.sub(r"[^a-z0-9]", "", name.lower())
    return surahs_dict.get(key, name)


def build_title(reciter_ar, parsed, surahs_dict):
    surah_ar_list = [translate_surah(s, surahs_dict) for s in parsed["surahs"]]
    surahs_part = " و ".join(surah_ar_list)
    prayer_ar = PRAYER_AR[parsed["prayer"]]
    return f"{reciter_ar} | سورة {surahs_part} - صلاة {prayer_ar} {parsed['date']}"


def find_image(folder):
    for p in folder.iterdir():
        if p.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp"):
            return p
    return None


def make_video(audio, image, output):
    cmd = [
        "ffmpeg", "-y", "-loop", "1", "-i", str(image), "-i", str(audio),
        "-c:v", "libx264", "-tune", "stillimage", "-preset", "medium",
        "-c:a", "aac", "-b:a", "192k",
        "-pix_fmt", "yuv420p", "-shortest",
        "-vf",
        "scale='min(1280,iw*720/ih)':'min(720,ih*1280/iw)':force_original_aspect_ratio=decrease,"
        "pad=1280:720:(1280-iw)/2:(720-ih)/2:color=black",
        str(output),
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def resolve_client_secret(yt_cfg):
    """Return the path to client_secret.json, resolving relative paths from ROOT."""
    name = yt_cfg.get("client_secret_file", "client_secret.json")
    path = Path(name)
    if not path.is_absolute():
        path = ROOT / path
    return path


def get_credentials(yt_cfg, interactive=True):
    """Load / refresh / acquire YouTube credentials.

    interactive=True  → may open the browser OAuth flow (for CLI / explicit Connect button)
    interactive=False → silent: refresh if possible, else raise (for background verify on launch)

    Raises FileNotFoundError if client_secret.json is missing.
    Raises RuntimeError if interactive=False and no valid credentials are obtainable.
    """
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow

    client_secret = resolve_client_secret(yt_cfg)

    creds = None
    if TOKEN_FILE.exists():
        creds = Credentials.from_authorized_user_file(str(TOKEN_FILE), SCOPES)

    if creds and creds.valid:
        return creds

    if creds and creds.expired and creds.refresh_token:
        try:
            creds.refresh(Request())
            TOKEN_FILE.write_text(creds.to_json())
            return creds
        except Exception as e:
            if not interactive:
                raise RuntimeError(f"Token refresh failed: {e}") from e
            # else fall through to browser flow

    if not interactive:
        raise RuntimeError("No valid token; run --setup or click Connect to authenticate.")

    if not client_secret.exists():
        raise FileNotFoundError(
            f"client_secret.json not found at '{client_secret}'.\n"
            f"Run 'python make_videos.py --setup' to create one,\n"
            f"or download it from Google Cloud Console and place it in the script/ folder."
        )

    flow = InstalledAppFlow.from_client_secrets_file(str(client_secret), SCOPES)
    creds = flow.run_local_server(port=0)
    TOKEN_FILE.write_text(creds.to_json())
    return creds


def upload_video(youtube, video_path, title, yt_cfg):
    from googleapiclient.http import MediaFileUpload
    body = {
        "snippet": {
            "title": title,
            "description": yt_cfg.get("description", ""),
            "categoryId": str(yt_cfg.get("category_id", "22")),
            "tags": yt_cfg.get("tags", []),
        },
        "status": {
            "privacyStatus": yt_cfg.get("privacy", "public"),
            "selfDeclaredMadeForKids": yt_cfg.get("made_for_kids", False),
        },
    }
    media = MediaFileUpload(str(video_path), chunksize=-1, resumable=True, mimetype="video/mp4")
    req = youtube.videos().insert(part="snippet,status", body=body, media_body=media)
    response = None
    while response is None:
        _, response = req.next_chunk()
    return response["id"]


def add_to_playlist(youtube, video_id, playlist_id):
    youtube.playlistItems().insert(
        part="snippet",
        body={"snippet": {
            "playlistId": playlist_id,
            "resourceId": {"kind": "youtube#video", "videoId": video_id},
        }},
    ).execute()


def quota_used_today():
    if not QUOTA_FILE.exists():
        return 0
    data = json.loads(QUOTA_FILE.read_text())
    today = datetime.now(timezone.utc).date().isoformat()
    return data.get("count", 0) if data.get("date") == today else 0


def record_quota_use():
    today = datetime.now(timezone.utc).date().isoformat()
    count = quota_used_today() + 1
    QUOTA_FILE.write_text(json.dumps({"date": today, "count": count}))


def iter_reciter_folders(reciters):
    """Yield (folder, config) for every subfolder that contains audio files.
    Auto-discovers folders; reciters.json only needed for name_ar and playlist_id."""
    for folder in sorted(p for p in WORK_DIR.iterdir() if p.is_dir() and not p.name.startswith(".")):
        has_audio = any(f.suffix.lower() in AUDIO_EXTS for f in folder.iterdir() if f.is_file())
        if not has_audio:
            continue
        config = dict(reciters.get(folder.name, {}))
        # Auto-derive prefix from folder name if not explicitly set
        if not config.get("filename_prefix"):
            config["filename_prefix"] = folder.name.replace(" ", "")
        yield folder, config


def collect_work(reciters, surahs_dict):
    todo = []
    for folder, config in iter_reciter_folders(reciters):
        if not config.get("name_ar"):
            print(f"[skip] {folder.name}: no Arabic name — run --check to add it")
            continue
        image = find_image(folder)
        if not image:
            print(f"[skip] {folder.name}: no image found")
            continue
        prefix = config["filename_prefix"]
        for audio in sorted(folder.iterdir()):
            if audio.suffix.lower() not in AUDIO_EXTS:
                continue
            marker = audio.with_suffix(audio.suffix + ".uploaded")
            if marker.exists():
                continue
            parsed = parse_filename(audio, prefix)
            if not parsed:
                continue
            todo.append({"audio": audio, "image": image, "config": config,
                          "parsed": parsed, "marker": marker})
    return todo


# ---------------------------------------------------------------------------
# Diagnostic / check mode — surah analysis helpers
# ---------------------------------------------------------------------------

def clean_date_str(raw):
    """'14x.12.2024' → '14.12.2024', strips non-digit chars from day/month."""
    parts = raw.split(".")
    if len(parts) == 3:
        cleaned = [re.sub(r"[^\d]", "", p) for p in parts]
        if all(cleaned) and len(cleaned[2]) == 4:
            return f"{int(cleaned[0]):02d}.{int(cleaned[1]):02d}.{cleaned[2]}"
    return None


def strip_leading_descriptor(surah, surahs_dict):
    """
    Detect a leading non-surah prefix and return (descriptor, real_surah):
      'FINALmuminoon' → ('FINAL', 'Muminoon')
      'OUTSIDENahl'   → ('OUTSIDE', 'Nahl')
      'OlayanNisaa'   → ('Olayan', 'Nisaa')
    Returns (None, None) if no match.
    """
    # Strategy 1: all-caps prefix followed by lowercase — strip the full caps run
    # e.g. FINALmuminoon → FINAL + muminoon → Muminoon
    m = re.match(r"^([A-Z]{2,})([a-z].+)$", surah)
    if m:
        remainder = m.group(2)[0].upper() + m.group(2)[1:]
        if re.sub(r"[^a-z0-9]", "", remainder.lower()) in surahs_dict:
            return m.group(1), remainder
    # Strategy 2: scan for a suffix that starts uppercase and is a known surah.
    # Only split if we're not cutting through an all-caps run — the prefix must
    # end in lowercase OR be entirely uppercase (a single-letter/acronym descriptor
    # like 'T' or 'OUTSIDE').
    # e.g. OUTSIDENahl → OUTSIDE + Nahl; OlayanNisaa → Olayan + Nisaa; THashr → T + Hashr
    for i in range(1, len(surah)):
        candidate = surah[i:]
        prefix = surah[:i]
        if candidate[0].isupper() and (prefix[-1].islower() or prefix.isupper()):
            if re.sub(r"[^a-z0-9]", "", candidate.lower()) in surahs_dict:
                return prefix, candidate
    return None, None


def split_missing_separator(surah, surahs_dict):
    """
    Detect a known surah name as a prefix of the string, with trailing text:
      'ShamsLayl'    → ('Shams', 'Layl')   — missing • between two surahs
      'SajdahInsan'  → ('Sajdah', 'Insan')
      'GhafirFiroun' → ('Ghafir', 'Firoun') — Firoun is a section descriptor
    Returns (None, None) if no match.
    """
    for length in range(len(surah) - 1, 1, -1):
        candidate = surah[:length]
        if re.sub(r"[^a-z0-9]", "", candidate.lower()) in surahs_dict:
            rest = surah[length:]
            if rest:
                return candidate, rest
    return None, None


def analyse_surah(surah, surahs_dict):
    """
    Returns (clean_surahs, issue_description) where clean_surahs is a list of
    corrected surah name strings, or (None, description) if unresolvable.
    """
    key = re.sub(r"[^a-z0-9]", "", surah.lower())
    if key in surahs_dict:
        return [surah], None  # already fine

    # Try two surahs merged without • ('ShamsLayl', 'SajdahInsan', 'GhafirFiroun')
    # Check this FIRST so 'Shams' in 'ShamsLayl' is treated as a surah, not a descriptor
    first, rest = split_missing_separator(surah, surahs_dict)
    if first:
        rest_key = re.sub(r"[^a-z0-9]", "", rest.lower())
        if rest_key in surahs_dict:
            return [first, rest], f"'{surah}' — two surahs without '•', split into '{first}•{rest}'"
        else:
            return [first], f"'{surah}' — trailing section/descriptor '{rest}' removed"

    # Try leading descriptor ('FINALmuminoon', 'OUTSIDENahl', 'OlayanNisaa')
    descriptor, real_surah = strip_leading_descriptor(surah, surahs_dict)
    if real_surah:
        return [real_surah], f"'{surah}' — stripped leading descriptor '{descriptor}'"

    return None, f"'{surah}' not recognised — add to surahs.json or rename"


def build_stem(prefix, prayer, surahs, date):
    return f"{prefix}{prayer}{'•'.join(surahs)}-{date}"


# ---------------------------------------------------------------------------
# Interactive rename prompt
# ---------------------------------------------------------------------------

def prompt_rename(audio, issue_desc, suggestion=None):
    """
    Print the issue, optionally show a suggestion, and ask the user what to do.
    Returns the (possibly renamed) Path.
    """
    print(f"\n  ✗  {audio.parent.name}/{audio.name}")
    print(f"     Issue: {issue_desc}")
    if suggestion:
        print(f"     Suggested: {suggestion}")
        resp = input("     [Enter=accept suggestion / type new name / s=skip]: ").strip()
        if resp.lower() == "s":
            print("     → skipped")
            return audio
        new_name = resp if resp else suggestion
    else:
        print(f"     Valid prayers: {', '.join(PRAYER_AR.keys())}")
        new_name = input("     New filename (without extension, or Enter to skip): ").strip()
        if not new_name:
            print("     → skipped")
            return audio

    ext = audio.suffix
    if not new_name.endswith(ext):
        new_name += ext

    new_path = audio.parent / new_name
    if new_path == audio:
        print("     → unchanged")
        return audio
    if new_path.exists():
        print(f"     ✗ '{new_name}' already exists — skipped")
        return audio

    audio.rename(new_path)
    print(f"     ✓ renamed → {new_name}")
    return new_path


# ---------------------------------------------------------------------------
# Main check logic
# ---------------------------------------------------------------------------

def run_check(reciters, surahs_dict):
    """Scan all reciter folders, report issues, and interactively rename problematic files."""

    # ── Step 1: register any new folders that are missing an Arabic name ──────
    json_updated = False
    for folder, config in iter_reciter_folders(reciters):
        if not config.get("name_ar"):
            print(f"\n  New reciter folder detected: {folder.name}")
            name_ar = input("  Arabic name (or Enter to skip for now): ").strip()
            if name_ar:
                if folder.name not in reciters:
                    reciters[folder.name] = {}
                reciters[folder.name]["name_ar"] = name_ar
                playlist_id = input("  YouTube playlist ID (or Enter to skip): ").strip()
                if playlist_id:
                    reciters[folder.name]["playlist_id"] = playlist_id
                json_updated = True
                print(f"  ✓ saved")

    if json_updated:
        with open(RECITERS_CONFIG, "w", encoding="utf-8") as f:
            json.dump(reciters, f, ensure_ascii=False, indent=2)
        print(f"\n  ✓ reciters.json updated\n")

    # ── Step 2: scan files for issues ─────────────────────────────────────────
    ok_count = 0
    issue_count = 0

    for folder, config in iter_reciter_folders(reciters):
        if not config.get("name_ar"):
            continue  # still skipped if user chose not to fill in name
        prefix = config["filename_prefix"]

        if not find_image(folder):
            print(f"\n⚠  {folder.name}: no image — add a .jpg/.png to this folder")

        for audio in sorted(folder.iterdir()):
            if audio.suffix.lower() not in AUDIO_EXTS:
                continue
            if audio.with_suffix(audio.suffix + ".uploaded").exists():
                continue

            stem = audio.stem

            # --- Prefix mismatch ---
            if not stem.lower().startswith(prefix.lower()):
                issue_count += 1
                audio = prompt_rename(
                    audio,
                    f"doesn't start with '{prefix}' — not a standard recitation file, "
                    f"or rename to match the pattern",
                )
                continue

            rest = stem[len(prefix):]

            # --- No prayer found ---
            prayer_match = re.search(rf"(?i)({PRAYERS_RE})", rest)
            if not prayer_match:
                issue_count += 1
                # Try to fix date if dirty
                dirty = DATE_DIRTY_RE.search(rest)
                date_hint = ""
                if dirty:
                    fixed = clean_date_str(dirty.group())
                    date_hint = f" (date cleaned to {fixed})" if fixed else ""
                audio = prompt_rename(
                    audio,
                    f"no prayer found in '{rest}'{date_hint}",
                )
                continue

            # --- Prayer not at start (reversed) ---
            if prayer_match.start() != 0:
                issue_count += 1
                before = rest[:prayer_match.start()]
                prayer = prayer_match.group()
                # Try to extract date for suggestion
                date_m = DATE_LOOSE_RE.search(rest) or DATE_DIRTY_RE.search(rest)
                suggestion = None
                if date_m:
                    date_raw = date_m.group()
                    date_clean = clean_date_str(date_raw) or date_raw
                    suggestion = f"{prefix}{prayer}{before}-{date_clean}{audio.suffix}"
                audio = prompt_rename(
                    audio,
                    f"prayer '{prayer}' comes after surah '{before}' — order reversed",
                    suggestion,
                )
                continue

            # --- Malformed / missing date ---
            parsed = parse_filename(audio, prefix)
            if not parsed:
                date_m = DATE_DIRTY_RE.search(rest)
                issue_count += 1
                suggestion = None
                if date_m:
                    fixed_date = clean_date_str(date_m.group())
                    if fixed_date:
                        # Rebuild best-guess stem without the bad date
                        surah_part = rest[prayer_match.end():rest.rfind("-")]
                        prayer_word = PRAYER_LOWER[prayer_match.group().lower()]
                        suggestion = f"{prefix}{prayer_word}{surah_part}-{fixed_date}{audio.suffix}"
                audio = prompt_rename(
                    audio,
                    f"malformed or missing date in '{rest}'",
                    suggestion,
                )
                continue

            # --- Surah name issues ---
            all_clean_surahs = []
            surah_issues = []
            needs_rename = False

            for surah in parsed["surahs"]:
                clean, issue = analyse_surah(surah, surahs_dict)
                if clean is None:
                    surah_issues.append(issue)
                    all_clean_surahs.append(surah)  # keep as-is; user must fix
                    needs_rename = True
                elif issue:
                    surah_issues.append(issue)
                    all_clean_surahs.extend(clean)
                    needs_rename = True
                else:
                    all_clean_surahs.extend(clean)

            if needs_rename:
                issue_count += 1
                suggestion = None
                if not any(c is None for c in all_clean_surahs):
                    suggestion = (
                        build_stem(prefix, parsed["prayer"], all_clean_surahs, parsed["date"])
                        + audio.suffix
                    )
                audio = prompt_rename(
                    audio,
                    "; ".join(surah_issues),
                    suggestion,
                )
            else:
                ok_count += 1

    print(f"\n{'─'*50}")
    if issue_count:
        print(f"Done. {ok_count} OK, {issue_count} issue(s) processed.")
    else:
        print(f"✓ All {ok_count} file(s) look good.")


# ---------------------------------------------------------------------------
# Non-interactive file scanner (used by GUI)
# ---------------------------------------------------------------------------

def scan_files(reciters, surahs_dict):
    """
    Non-interactive scan of all reciter folders.
    Returns a list of folder dicts, each containing a 'files' list.

    folder dict keys: folder, folder_name, name_ar, has_image, missing_name_ar, files
    file dict keys:   audio, status ('ok'|'warning'|'error'|'uploaded'), issue, suggestion, parsed
    """
    results = []
    for folder, config in iter_reciter_folders(reciters):
        name_ar = config.get("name_ar", "")
        prefix = config["filename_prefix"]
        folder_data = {
            "folder": folder,
            "folder_name": folder.name,
            "name_ar": name_ar,
            "has_image": find_image(folder) is not None,
            "missing_name_ar": not name_ar,
            "files": [],
        }

        for audio in sorted(folder.iterdir()):
            if audio.suffix.lower() not in AUDIO_EXTS:
                continue

            marker = audio.with_suffix(audio.suffix + ".uploaded")
            if marker.exists():
                folder_data["files"].append({
                    "audio": audio,
                    "status": "uploaded",
                    "issue": None,
                    "suggestion": None,
                    "parsed": parse_filename(audio, prefix),
                })
                continue

            stem = audio.stem
            fi = {"audio": audio, "status": "ok", "issue": None, "suggestion": None, "parsed": None}

            if not stem.lower().startswith(prefix.lower()):
                fi["status"] = "error"
                fi["issue"] = f"doesn't start with '{prefix}'"
                folder_data["files"].append(fi)
                continue

            rest = stem[len(prefix):]
            prayer_match = re.search(rf"(?i)({PRAYERS_RE})", rest)

            if not prayer_match:
                dirty = DATE_DIRTY_RE.search(rest)
                date_hint = ""
                if dirty:
                    fixed = clean_date_str(dirty.group())
                    date_hint = f" (date cleaned to {fixed})" if fixed else ""
                fi["status"] = "error"
                fi["issue"] = f"no prayer found in '{rest}'{date_hint}"
                folder_data["files"].append(fi)
                continue

            if prayer_match.start() != 0:
                before = rest[:prayer_match.start()]
                prayer = prayer_match.group()
                date_m = DATE_LOOSE_RE.search(rest) or DATE_DIRTY_RE.search(rest)
                if date_m:
                    date_raw = date_m.group()
                    date_clean = clean_date_str(date_raw) or date_raw
                    fi["suggestion"] = f"{prefix}{prayer}{before}-{date_clean}{audio.suffix}"
                fi["status"] = "warning"
                fi["issue"] = f"prayer '{prayer}' comes after surah — order reversed"
                folder_data["files"].append(fi)
                continue

            parsed = parse_filename(audio, prefix)
            if not parsed:
                date_m = DATE_DIRTY_RE.search(rest)
                fi["status"] = "warning"
                if date_m:
                    fixed_date = clean_date_str(date_m.group())
                    if fixed_date:
                        surah_part = rest[prayer_match.end():rest.rfind("-")]
                        prayer_word = PRAYER_LOWER[prayer_match.group().lower()]
                        fi["suggestion"] = f"{prefix}{prayer_word}{surah_part}-{fixed_date}{audio.suffix}"
                fi["issue"] = f"malformed or missing date in '{rest}'"
                folder_data["files"].append(fi)
                continue

            # Surah analysis
            all_clean, issues, needs_rename = [], [], False
            for surah in parsed["surahs"]:
                clean, issue = analyse_surah(surah, surahs_dict)
                if clean is None:
                    issues.append(issue)
                    all_clean.append(surah)
                    needs_rename = True
                elif issue:
                    issues.append(issue)
                    all_clean.extend(clean)
                    needs_rename = True
                else:
                    all_clean.extend(clean)

            if needs_rename:
                fi["status"] = "warning"
                fi["issue"] = "; ".join(issues)
                fi["parsed"] = parsed
                if not any(c is None for c in all_clean):
                    fi["suggestion"] = (
                        build_stem(prefix, parsed["prayer"], all_clean, parsed["date"])
                        + audio.suffix
                    )
            else:
                fi["status"] = "ok"
                fi["parsed"] = parsed

            folder_data["files"].append(fi)

        results.append(folder_data)
    return results


# ---------------------------------------------------------------------------
# Playlist resolution (used by GUI and CLI upload)
# ---------------------------------------------------------------------------

def _surah_key(name):
    """Normalise a surah name for case/punctuation-insensitive lookups."""
    return re.sub(r"[^a-z0-9]", "", name.lower())


def get_playlists_for_item(item, playlists_data):
    """Return a deduplicated list of playlist IDs to add this upload to.

    Checks three sources in order:
      1. Reciter playlist  (reciters.json → playlist_id, playlist_enabled)
      2. Prayer playlist   (playlists.json → prayers → <Prayer>)
      3. Surah playlist(s) (playlists.json → surahs  → <Surah>)

    Surah lookup is case- and punctuation-insensitive: 'Baqarah', 'baqarah',
    and 'Al-Baqarah' all match the same entry.
    """
    ids, seen = [], set()

    def _add(pid):
        if pid and pid not in seen:
            ids.append(pid)
            seen.add(pid)

    cfg = item["config"]
    if cfg.get("playlist_enabled", True) and cfg.get("playlist_id"):
        _add(cfg["playlist_id"])

    prayer = item["parsed"]["prayer"]
    pcfg = playlists_data.get("prayers", {}).get(prayer, {})
    if pcfg.get("enabled") and pcfg.get("playlist_id"):
        _add(pcfg["playlist_id"])

    surah_lookup = {
        _surah_key(k): v for k, v in playlists_data.get("surahs", {}).items()
    }
    for surah in item["parsed"]["surahs"]:
        scfg = surah_lookup.get(_surah_key(surah), {})
        if scfg.get("enabled") and scfg.get("playlist_id"):
            _add(scfg["playlist_id"])

    return ids


# ---------------------------------------------------------------------------
# Google Cloud setup wizard
# ---------------------------------------------------------------------------

def _gcloud(*args, capture=False, check=True):
    """Run a gcloud command.  If capture=True, return stdout as a string."""
    result = subprocess.run(
        ["gcloud"] + list(args),
        capture_output=capture, text=True, check=False,
    )
    if check and result.returncode != 0:
        err = result.stderr.strip() if capture else ""
        raise RuntimeError(f"gcloud {' '.join(args)} failed. {err}".strip())
    return result.stdout.strip() if capture else None


def verify_youtube_connection(yt_cfg, verbose=False, interactive=True):
    """Authenticate and confirm which YouTube channel we're connected to.
    Prints a confirmation if verbose=True.  Returns channel title or None."""
    from googleapiclient.discovery import build
    try:
        creds = get_credentials(yt_cfg, interactive=interactive)
        youtube = build("youtube", "v3", credentials=creds)
        items = youtube.channels().list(part="snippet", mine=True).execute().get("items", [])
        if not items:
            raise RuntimeError("No YouTube channel found for this account.")
        title = items[0]["snippet"]["title"]
        if verbose:
            print(f"\n✓ Connected to YouTube channel: {title}")
            print(f"  Token saved → {TOKEN_FILE}")
        return title
    except Exception as e:
        if verbose:
            print(f"\n✗ YouTube connection failed: {e}")
        return None


def run_setup(yt_cfg):
    import random
    import shutil
    import string
    import time
    import webbrowser

    hr = "─" * 52
    print(f"\n{hr}")
    print("  YouTube API Setup Wizard")
    print(f"{hr}\n")
    print("This will create a Google Cloud project, enable the YouTube")
    print("API, and connect it to your YouTube account.\n")

    # ── Step 1: gcloud CLI ───────────────────────────────────────────────────
    print("Step 1/5  Checking for Google Cloud CLI (gcloud)...")
    gcloud_path = shutil.which("gcloud")
    if not gcloud_path:
        print("\n  gcloud is not installed. Install it, then re-run --setup.\n")
        system = sys.platform
        if system == "win32":
            print("  Recommended (Windows) — run in an admin PowerShell:")
            print("    winget install Google.CloudSDK\n")
            print("  Or download the installer from:")
        else:
            print("  Download from:")
        print("    https://cloud.google.com/sdk/docs/install\n")
        print("  After installing, open a new terminal window and run:")
        print("    gcloud init")
        return
    print(f"  ✓ Found: {gcloud_path}")

    # ── Step 2: Sign in to gcloud ────────────────────────────────────────────
    print("\nStep 2/5  Sign in to Google Cloud...")
    print("  Use the Google account that owns the YouTube channel.")
    print("  A browser window will open.\n")
    input("  Press Enter to open the browser...")
    try:
        _gcloud("auth", "login", check=True)
    except RuntimeError:
        print("  Sign-in failed or was cancelled. Re-run --setup to try again.")
        return

    # Get the signed-in email for later use
    email = _gcloud("config", "get-value", "account", capture=True, check=False) or ""
    if email:
        print(f"  ✓ Signed in as: {email}")

    # ── Step 3: Create project & enable YouTube API ──────────────────────────
    print("\nStep 3/5  Creating Google Cloud project...")
    suffix = "".join(random.choices(string.digits, k=6))
    project_id = f"reciter-uploader-{suffix}"

    try:
        _gcloud("projects", "create", project_id, f"--name=Reciter Uploader")
        _gcloud("config", "set", "project", project_id)
        print(f"  ✓ Project created: {project_id}")
    except RuntimeError as e:
        print(f"  ✗ Could not create project: {e}")
        return

    print("  Enabling YouTube Data API v3 (may take a moment)...")
    try:
        _gcloud("services", "enable", "youtube.googleapis.com")
        print("  ✓ YouTube Data API enabled")
    except RuntimeError as e:
        print(f"  ✗ Could not enable API: {e}")
        return

    # Save project_id into youtube.json for reference
    yt_cfg["_gcloud_project"] = project_id
    with open(YOUTUBE_CONFIG, "w", encoding="utf-8") as f:
        json.dump(yt_cfg, f, indent=2, ensure_ascii=False)

    # ── Step 4: OAuth consent screen ─────────────────────────────────────────
    consent_url = (
        f"https://console.cloud.google.com/apis/credentials/consent"
        f"?project={project_id}"
    )
    print(f"\nStep 4/5  Configure OAuth consent screen")
    print("  Fill in just these fields, leave everything else as default:\n")
    print("    User type    → External")
    print(f"    App name     → Reciter Uploader")
    if email:
        print(f"    Support email → {email}")
    print("    (scroll down) Test users → add your own email\n")
    print(f"  Opening: {consent_url}")
    webbrowser.open(consent_url)
    input("\n  Press Enter once you have saved the consent screen...")

    # ── Step 5: Create & download OAuth credentials ──────────────────────────
    creds_url = (
        f"https://console.cloud.google.com/apis/credentials/oauthclient"
        f"?project={project_id}"
    )
    client_secret_dest = resolve_client_secret(yt_cfg)
    downloads_dir = Path.home() / "Downloads"

    print(f"\nStep 5/5  Create OAuth credentials")
    print("  In the browser:")
    print("    Application type → Desktop app")
    print("    Name             → Reciter Uploader")
    print("    Click Create, then download the JSON file.\n")
    print(f"  Opening: {creds_url}")
    webbrowser.open(creds_url)

    print(f"\n  Waiting for client_secret*.json in {downloads_dir} ...")
    print("  (or save it manually to:")
    print(f"   {client_secret_dest}  then press Enter)\n")

    deadline = time.time() + 300  # wait up to 5 minutes
    found = False
    while time.time() < deadline:
        # Already in the right place?
        if client_secret_dest.exists():
            found = True
            break
        # Landed in Downloads?
        candidates = sorted(
            downloads_dir.glob("client_secret*.json"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        if candidates:
            shutil.move(str(candidates[0]), str(client_secret_dest))
            print(f"  ✓ Moved {candidates[0].name} → {client_secret_dest.name}")
            found = True
            break
        time.sleep(2)

    if not found:
        print(f"  File not detected. Save it manually to:")
        print(f"    {client_secret_dest}")
        print("  Then run:  python make_videos.py --auth")
        return

    # ── Final: verify the connection ─────────────────────────────────────────
    print("\n  Verifying connection to YouTube...")
    name = verify_youtube_connection(yt_cfg, verbose=False)
    if name:
        print(f"\n{hr}")
        print(f"  ✓ All done! Connected to YouTube channel: {name}")
        print(f"{hr}")
        print("\n  Next steps:")
        print("    python make_videos.py --check      ← fix any filename issues")
        print("    python make_videos.py --dry-run    ← preview titles")
        print("    python make_videos.py              ← start uploading\n")
    else:
        print("  Credentials saved but connection test failed.")
        print("  Try:  python make_videos.py --auth")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Audio → YouTube video pipeline.")
    ap.add_argument("--setup",   action="store_true",
                    help="first-time: create Google Cloud project and connect YouTube account")
    ap.add_argument("--auth",    action="store_true",
                    help="re-authenticate YouTube account and confirm connection")
    ap.add_argument("--check",   action="store_true",
                    help="scan for filename issues and fix them interactively")
    ap.add_argument("--dry-run", action="store_true",
                    help="encode videos but skip upload")
    ap.add_argument("--limit",   type=int, default=None,
                    help="max uploads this run (overrides daily_limit in youtube.json)")
    ap.add_argument("--watch",   action="store_true",
                    help="run continuously, polling for new files and uploading")
    args = ap.parse_args()

    # youtube.json is always loaded (controls auth paths and upload settings)
    yt_cfg = load_json(YOUTUBE_CONFIG) if YOUTUBE_CONFIG.exists() else {}
    if args.limit is not None:
        daily_limit = args.limit
    else:
        try:
            daily_limit = int(yt_cfg.get("daily_limit", 6))
        except (TypeError, ValueError):
            daily_limit = 6

    # --setup and --auth don't need reciters or surahs
    if args.setup:
        run_setup(yt_cfg)
        return

    if args.auth:
        verify_youtube_connection(yt_cfg, verbose=True)
        return

    if args.watch:
        run_watcher()
        return

    # All remaining modes need reciters.json
    if not RECITERS_CONFIG.exists():
        # Auto-create an empty one so --check can register new folders
        RECITERS_CONFIG.write_text("{}\n", encoding="utf-8")
    reciters = load_json(RECITERS_CONFIG)
    surahs_dict = load_json(SURAHS_FILE)

    if args.check:
        run_check(reciters, surahs_dict)
        return

    # ── Upload mode ───────────────────────────────────────────────────────────
    todo = collect_work(reciters, surahs_dict)
    if not todo:
        print("Nothing to upload.")
        return

    used = quota_used_today()
    remaining = max(0, daily_limit - used)
    print(f"Found {len(todo)} unprocessed files. Already used {used} today, "
          f"will process up to {remaining} more.")

    if remaining == 0 and not args.dry_run:
        print("Daily limit already reached. Try again after midnight Pacific Time.")
        return

    from googleapiclient.discovery import build
    creds  = None if args.dry_run else get_credentials(yt_cfg)
    youtube = None if args.dry_run else build("youtube", "v3", credentials=creds)

    playlists_data = load_playlists()
    processed = 0
    for item in todo:
        if not args.dry_run and processed >= remaining:
            print("Hit daily limit. Stopping.")
            break

        title      = build_title(item["config"]["name_ar"], item["parsed"], surahs_dict)
        video_path = item["audio"].with_suffix(".mp4")

        try:
            if not video_path.exists():
                print(f"[encode] {item['audio'].name}")
                make_video(item["audio"], item["image"], video_path)
            else:
                print(f"[encode] {item['audio'].name} (reusing existing)")

            if args.dry_run:
                print(f"[dry-run] {title}")
                processed += 1
                continue

            print(f"[upload] {title}")
            video_id = upload_video(youtube, video_path, title, yt_cfg)
            print(f"  ↳ https://youtu.be/{video_id}")

            # Write marker FIRST so a playlist failure can't cause a re-upload.
            item["marker"].write_text(json.dumps({
                "video_id": video_id,
                "title": title,
                "uploaded_at": datetime.now(timezone.utc).isoformat(),
            }, ensure_ascii=False, indent=2))
            record_quota_use()
            processed += 1

            # Playlist adds are non-fatal: a bad playlist ID shouldn't undo the upload.
            for pid in get_playlists_for_item(item, playlists_data):
                try:
                    add_to_playlist(youtube, video_id, pid)
                    print(f"  ↳ added to playlist {pid}")
                except Exception as pe:
                    print(f"  ✗ could not add to playlist {pid}: {pe}")

        except subprocess.CalledProcessError as e:
            stderr = e.stderr.decode(errors="replace") if e.stderr else ""
            print(f"[error] ffmpeg failed for {item['audio'].name}:\n{stderr}")
        except Exception as e:
            print(f"[error] {item['audio'].name}: {e}")
            if "quota" in str(e).lower():
                print("Quota exhausted. Stopping.")
                break

    print(f"\nDone. Processed {processed} file(s).")


if __name__ == "__main__":
    main()
