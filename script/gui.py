"""
gui.py — GUI wrapper for the Yoosy Joosy upload pipeline.
Run with:  python script/gui.py
"""

import json
import os
import subprocess
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))

import customtkinter as ctk
from tkinter import messagebox

import make_videos as mv

# ── Theme ─────────────────────────────────────────────────────────────────────
ctk.set_appearance_mode("dark")
ctk.set_default_color_theme("blue")

C_OK      = "#22c55e"
C_WARN    = "#f59e0b"
C_ERR     = "#ef4444"
C_UPLOAD  = "#3b82f6"
C_MUTED   = "#6b7280"
C_CARD    = "#1e293b"
C_CARD2   = "#0f172a"
C_HEADER  = "#020617"

STATUS_ICON  = {"ok": "✓", "warning": "⚠", "error": "✗", "uploaded": "↑"}
STATUS_COLOR = {"ok": C_OK, "warning": C_WARN, "error": C_ERR, "uploaded": C_MUTED}


# ─────────────────────────────────────────────────────────────────────────────
# Playlist Manager (modal window)
# ─────────────────────────────────────────────────────────────────────────────

class PlaylistWindow(ctk.CTkToplevel):
    """
    Modal window for configuring which YouTube playlists videos are added to.
    Three sections:
      - By Reciter  — one row per detected reciter folder
      - By Prayer   — one row per prayer type
      - By Surah    — user-defined rows (add/remove freely)
    Each row has: [Toggle] [Label] [Playlist ID entry] [Fetch from YouTube]
    """

    def __init__(self, parent, reciters, playlists_data, surahs_dict, youtube, on_save):
        super().__init__(parent)
        self.title("Playlist Assignments")
        self.geometry("760x740")
        self.minsize(680, 500)
        self.grab_set()

        self.reciters       = reciters
        self.playlists_data = playlists_data
        self.surahs_dict    = surahs_dict
        self.youtube        = youtube
        self.on_save        = on_save

        # Widget maps for reading back on save
        self._reciter_rows = {}   # folder_name → {entry, toggle_var}
        self._prayer_rows  = {}   # prayer       → {entry, toggle_var}
        self._surah_rows   = {}   # key          → {name_entry, entry, toggle_var, row}

        self._build()

    # ── Build ─────────────────────────────────────────────────────────────────

    def _build(self):
        ctk.CTkLabel(
            self, text="🎵  Playlist Assignments",
            font=ctk.CTkFont(size=16, weight="bold"),
        ).pack(padx=20, pady=(16, 2), anchor="w")

        ctk.CTkLabel(
            self,
            text="Each uploaded video is added to every enabled matching playlist.\n"
                 "Toggle the switch to enable/disable each assignment. Click Fetch to pick from your channel.",
            font=ctk.CTkFont(size=12), text_color=C_MUTED, justify="left",
        ).pack(padx=20, pady=(0, 10), anchor="w")

        self._scroll = ctk.CTkScrollableFrame(self, fg_color="transparent")
        self._scroll.pack(fill="both", expand=True, padx=12, pady=0)

        self._build_reciter_section()
        self._build_prayer_section()
        self._build_surah_section()

        # Save / Cancel bar
        bar = ctk.CTkFrame(self, fg_color="transparent", height=56)
        bar.pack(fill="x", padx=16, pady=10)
        bar.pack_propagate(False)

        ctk.CTkButton(
            bar, text="Cancel",
            width=100, height=38,
            fg_color="transparent", border_width=1,
            command=self.destroy,
        ).pack(side="right", padx=(8, 0))

        ctk.CTkButton(
            bar, text="Save Changes",
            width=150, height=38,
            fg_color=C_OK, hover_color="#16a34a",
            font=ctk.CTkFont(size=13, weight="bold"),
            command=self._save,
        ).pack(side="right")

    def _section_label(self, text):
        ctk.CTkLabel(
            self._scroll, text=text,
            font=ctk.CTkFont(size=13, weight="bold"),
        ).pack(fill="x", padx=4, pady=(16, 4), anchor="w")

    def _build_reciter_section(self):
        self._section_label("👤  By Reciter")
        seen = set()

        # Show every detected reciter folder, even if it's not yet in reciters.json,
        # so a freshly-dropped folder can be configured here without touching JSON.
        for folder, _config in mv.iter_reciter_folders(self.reciters):
            seen.add(folder.name)
            self._reciter_rows[folder.name] = self._reciter_row(folder.name, missing_folder=False)

        # Surface reciters.json entries whose folder is missing/renamed so their
        # playlist data isn't silently dropped on save.
        for folder_name in self.reciters:
            if folder_name not in seen:
                self._reciter_rows[folder_name] = self._reciter_row(folder_name, missing_folder=True)

    def _reciter_row(self, folder_name, missing_folder=False):
        """Three-line row containing every editable reciter field.

          Top:    [toggle] [folder name]
          Mid:    Arabic [____]  Playlist [____]  [Fetch]
          Bottom: Filename prefix [____] (advanced — leave blank to auto-derive)
        """
        cfg          = self.reciters.get(folder_name, {})
        name_ar      = cfg.get("name_ar", "")
        pl_id        = cfg.get("playlist_id", "")
        enabled      = cfg.get("playlist_enabled", bool(pl_id))
        prefix_ovr   = cfg.get("filename_prefix", "")

        row = ctk.CTkFrame(self._scroll, fg_color=C_CARD, corner_radius=6)
        row.pack(fill="x", pady=3, padx=4)

        # Top line — toggle + folder name (read-only, since it must match the directory)
        top = ctk.CTkFrame(row, fg_color="transparent")
        top.pack(fill="x", padx=8, pady=(8, 2))

        toggle_var = ctk.BooleanVar(value=enabled)
        ctk.CTkSwitch(
            top, text="", variable=toggle_var, width=44,
        ).pack(side="left", padx=(2, 8))

        head_text = folder_name + ("  (folder missing)" if missing_folder else "")
        head_color = C_WARN if missing_folder else "#e2e8f0"
        ctk.CTkLabel(
            top, text=head_text,
            font=ctk.CTkFont(size=12, weight="bold"),
            text_color=head_color,
        ).pack(side="left")

        # Bottom line — Arabic name + Playlist ID + Fetch
        bot = ctk.CTkFrame(row, fg_color="transparent")
        bot.pack(fill="x", padx=8, pady=(0, 8))

        ctk.CTkLabel(
            bot, text="Arabic:", font=ctk.CTkFont(size=10),
            text_color=C_MUTED, width=46, anchor="e",
        ).pack(side="left", padx=(46, 4))

        name_entry = ctk.CTkEntry(
            bot, placeholder_text="اسم القارئ",
            width=160, height=28,
            font=ctk.CTkFont(size=11),
        )
        if name_ar:
            name_entry.insert(0, name_ar)
        name_entry.pack(side="left", padx=4)

        ctk.CTkLabel(
            bot, text="Playlist:", font=ctk.CTkFont(size=10),
            text_color=C_MUTED, anchor="e",
        ).pack(side="left", padx=(8, 4))

        id_entry = ctk.CTkEntry(
            bot, placeholder_text="Playlist ID  (PL…)",
            width=190, height=28,
            font=ctk.CTkFont(size=11, family="Courier"),
        )
        if pl_id:
            id_entry.insert(0, pl_id)
        id_entry.pack(side="left", padx=4)

        ctk.CTkButton(
            bot, text="Fetch", width=56, height=28,
            font=ctk.CTkFont(size=11), fg_color=C_CARD2,
            command=lambda e=id_entry: self._open_picker(e),
        ).pack(side="left", padx=(4, 0))

        # Advanced: filename prefix override (rarely needed — auto-derived from folder name)
        adv = ctk.CTkFrame(row, fg_color="transparent")
        adv.pack(fill="x", padx=8, pady=(0, 8))

        ctk.CTkLabel(
            adv, text="Prefix:", font=ctk.CTkFont(size=10),
            text_color=C_MUTED, width=46, anchor="e",
        ).pack(side="left", padx=(46, 4))

        prefix_entry = ctk.CTkEntry(
            adv,
            placeholder_text=f"(auto: {folder_name.replace(' ', '')})",
            width=160, height=24,
            font=ctk.CTkFont(size=10, family="Courier"),
        )
        if prefix_ovr:
            prefix_entry.insert(0, prefix_ovr)
        prefix_entry.pack(side="left", padx=4)

        ctk.CTkLabel(
            adv,
            text="Advanced — only set if audio names don't start with the folder name.",
            font=ctk.CTkFont(size=9), text_color=C_MUTED,
        ).pack(side="left", padx=8)

        return {
            "name_entry": name_entry,
            "entry": id_entry,
            "toggle_var": toggle_var,
            "prefix_entry": prefix_entry,
        }

    def _build_prayer_section(self):
        self._section_label("🕌  By Prayer")
        prayers_cfg = self.playlists_data.get("prayers", {})
        for prayer, prayer_ar in mv.PRAYER_AR.items():
            cfg     = prayers_cfg.get(prayer, {})
            pl_id   = cfg.get("playlist_id", "")
            enabled = cfg.get("enabled", False)
            label   = f"{prayer}  ·  {prayer_ar}"
            row_data = self._playlist_row(label, pl_id, enabled)
            self._prayer_rows[prayer] = row_data

    def _build_surah_section(self):
        hdr = ctk.CTkFrame(self._scroll, fg_color="transparent")
        hdr.pack(fill="x", padx=4, pady=(16, 4))
        ctk.CTkLabel(
            hdr, text="📖  By Surah",
            font=ctk.CTkFont(size=13, weight="bold"),
        ).pack(side="left")
        ctk.CTkButton(
            hdr, text="+ Add Surah",
            width=100, height=28,
            font=ctk.CTkFont(size=11),
            fg_color=C_CARD,
            command=lambda: self._add_surah_row(),
        ).pack(side="right")

        surahs_cfg = self.playlists_data.get("surahs", {})
        for surah_name, cfg in surahs_cfg.items():
            self._add_surah_row(
                surah_name=surah_name,
                pl_id=cfg.get("playlist_id", ""),
                enabled=cfg.get("enabled", False),
            )

    # ── Row builders ──────────────────────────────────────────────────────────

    def _playlist_row(self, label, playlist_id, enabled):
        """Standard toggle + label + ID entry + Fetch button row."""
        row = ctk.CTkFrame(self._scroll, fg_color=C_CARD, corner_radius=6)
        row.pack(fill="x", pady=3, padx=4)

        toggle_var = ctk.BooleanVar(value=enabled)
        ctk.CTkSwitch(
            row, text="", variable=toggle_var, width=44,
            onvalue=True, offvalue=False,
        ).pack(side="left", padx=(10, 6), pady=8)

        ctk.CTkLabel(
            row, text=label,
            font=ctk.CTkFont(size=12), anchor="w", width=230,
        ).pack(side="left", padx=4)

        entry = ctk.CTkEntry(
            row, placeholder_text="Playlist ID  (PL…)",
            width=210, height=30,
            font=ctk.CTkFont(size=11, family="Courier"),
        )
        if playlist_id:
            entry.insert(0, playlist_id)
        entry.pack(side="left", padx=8, pady=6)

        ctk.CTkButton(
            row, text="Fetch",
            width=58, height=28,
            font=ctk.CTkFont(size=11),
            fg_color=C_CARD2,
            command=lambda e=entry: self._open_picker(e),
        ).pack(side="left", padx=(0, 8), pady=6)

        return {"entry": entry, "toggle_var": toggle_var}

    def _add_surah_row(self, surah_name="", pl_id="", enabled=False):
        row = ctk.CTkFrame(self._scroll, fg_color=C_CARD, corner_radius=6)
        row.pack(fill="x", pady=3, padx=4)

        toggle_var = ctk.BooleanVar(value=enabled)
        ctk.CTkSwitch(
            row, text="", variable=toggle_var, width=44,
        ).pack(side="left", padx=(10, 6), pady=8)

        name_entry = ctk.CTkEntry(
            row, placeholder_text="Surah  (e.g. Baqarah)",
            width=160, height=30, font=ctk.CTkFont(size=11),
        )
        if surah_name:
            name_entry.insert(0, surah_name)
        name_entry.pack(side="left", padx=4, pady=6)

        id_entry = ctk.CTkEntry(
            row, placeholder_text="Playlist ID  (PL…)",
            width=196, height=30,
            font=ctk.CTkFont(size=11, family="Courier"),
        )
        if pl_id:
            id_entry.insert(0, pl_id)
        id_entry.pack(side="left", padx=8, pady=6)

        ctk.CTkButton(
            row, text="Fetch", width=56, height=28,
            font=ctk.CTkFont(size=11), fg_color=C_CARD2,
            command=lambda e=id_entry: self._open_picker(e),
        ).pack(side="left", padx=(0, 4), pady=6)

        key = surah_name if surah_name else f"__new_{id(row)}"
        ctk.CTkButton(
            row, text="✕", width=28, height=28,
            font=ctk.CTkFont(size=11),
            fg_color="#7f1d1d", hover_color="#991b1b",
            command=lambda r=row, k=key: self._remove_surah(r, k),
        ).pack(side="left", padx=(0, 8), pady=6)

        self._surah_rows[key] = {
            "entry": id_entry,
            "name_entry": name_entry,
            "toggle_var": toggle_var,
            "row": row,
        }

    def _remove_surah(self, row, key):
        row.destroy()
        self._surah_rows.pop(key, None)

    # ── Playlist picker ───────────────────────────────────────────────────────

    def _open_picker(self, target_entry):
        if not self.youtube:
            messagebox.showwarning(
                "Not connected",
                "Connect to YouTube on the first page to fetch playlists.",
                parent=self,
            )
            return
        threading.Thread(
            target=self._fetch_playlists_thread,
            args=(target_entry,),
            daemon=True,
        ).start()

    def _fetch_playlists_thread(self, target_entry):
        try:
            resp  = self.youtube.playlists().list(
                part="snippet", mine=True, maxResults=50
            ).execute()
            items = resp.get("items", [])
            self.after(0, self._show_picker, items, target_entry)
        except Exception as e:
            self.after(0, messagebox.showerror, "Error", f"Could not fetch playlists:\n{e}")

    def _show_picker(self, items, target_entry):
        if not items:
            messagebox.showinfo("No playlists", "No playlists found on this channel.", parent=self)
            return

        dialog = ctk.CTkToplevel(self)
        dialog.title("Choose Playlist")
        dialog.geometry("500x420")
        dialog.grab_set()

        ctk.CTkLabel(
            dialog, text="Select a playlist:",
            font=ctk.CTkFont(size=13, weight="bold"),
        ).pack(padx=16, pady=(12, 6), anchor="w")

        scroll = ctk.CTkScrollableFrame(dialog, fg_color="transparent")
        scroll.pack(fill="both", expand=True, padx=8, pady=4)

        for item in items:
            pl_id    = item["id"]
            pl_title = item["snippet"]["title"]

            row = ctk.CTkFrame(scroll, fg_color=C_CARD, corner_radius=4)
            row.pack(fill="x", pady=2)

            ctk.CTkLabel(
                row, text=pl_title,
                font=ctk.CTkFont(size=12), anchor="w",
            ).pack(side="left", padx=10, pady=6, fill="x", expand=True)

            ctk.CTkLabel(
                row, text=pl_id,
                font=ctk.CTkFont(size=9, family="Courier"),
                text_color=C_MUTED,
            ).pack(side="left", padx=6)

            ctk.CTkButton(
                row, text="Select", width=68, height=28,
                font=ctk.CTkFont(size=11),
                command=lambda pid=pl_id, d=dialog, e=target_entry: self._pick(pid, d, e),
            ).pack(side="right", padx=8, pady=4)

    def _pick(self, pl_id, dialog, entry):
        entry.delete(0, "end")
        entry.insert(0, pl_id)
        dialog.destroy()

    # ── Save ─────────────────────────────────────────────────────────────────

    def _save(self):
        # Reciter rows → back into reciters dict
        # (name_ar, playlist_id, playlist_enabled, filename_prefix override)
        for folder_name, rd in self._reciter_rows.items():
            name_ar      = rd["name_entry"].get().strip()
            pl_id        = rd["entry"].get().strip()
            enabled      = rd["toggle_var"].get()
            prefix_ovr   = rd["prefix_entry"].get().strip()

            if folder_name not in self.reciters:
                self.reciters[folder_name] = {}
            entry = self.reciters[folder_name]

            if name_ar:
                entry["name_ar"] = name_ar
            elif "name_ar" in entry:
                # Cleared field → drop from JSON so the inline check-page input reappears
                del entry["name_ar"]

            entry["playlist_id"]      = pl_id
            entry["playlist_enabled"] = enabled

            if prefix_ovr:
                entry["filename_prefix"] = prefix_ovr
            elif "filename_prefix" in entry:
                del entry["filename_prefix"]

        mv.save_reciters(self.reciters)

        # Prayer playlists → playlists.json
        prayers_cfg = {}
        for prayer, rd in self._prayer_rows.items():
            prayers_cfg[prayer] = {
                "playlist_id": rd["entry"].get().strip(),
                "enabled":     rd["toggle_var"].get(),
            }

        # Surah playlists → playlists.json
        surahs_cfg = {}
        for _key, rd in self._surah_rows.items():
            surah_name = rd["name_entry"].get().strip()
            pl_id      = rd["entry"].get().strip()
            enabled    = rd["toggle_var"].get()
            if surah_name:
                surahs_cfg[surah_name] = {"playlist_id": pl_id, "enabled": enabled}

        mv.save_playlists({"prayers": prayers_cfg, "surahs": surahs_cfg})

        self.on_save()
        self.destroy()


# ─────────────────────────────────────────────────────────────────────────────
# Settings Window (modal)
# ─────────────────────────────────────────────────────────────────────────────

class SettingsWindow(ctk.CTkToplevel):
    """
    Edit upload defaults (youtube.json) and add new surah aliases (surahs.json).
    Save persists everything; Add Alias is its own immediate action so the user
    can teach the system mid-workflow without losing other unsaved changes.
    """

    PRIVACY_OPTIONS = ["public", "unlisted", "private"]

    def __init__(self, parent, yt_cfg, surahs_dict, on_save):
        super().__init__(parent)
        self.title("Settings")
        self.geometry("640x780")
        self.minsize(560, 600)
        self.grab_set()

        self.yt_cfg       = yt_cfg
        self.surahs_dict  = surahs_dict
        self.bg_cfg       = mv.load_background_config()
        self.on_save      = on_save
        self._aliases_added_this_session = []  # for the recent-adds panel

        self._build()
        # Refresh watcher status periodically while window is open
        self._poll_watcher_status()

    def _build(self):
        ctk.CTkLabel(
            self, text="⚙  Settings",
            font=ctk.CTkFont(size=16, weight="bold"),
        ).pack(padx=20, pady=(16, 12), anchor="w")

        scroll = ctk.CTkScrollableFrame(self, fg_color="transparent")
        scroll.pack(fill="both", expand=True, padx=12, pady=0)

        self._build_upload_section(scroll)
        self._build_background_section(scroll)
        self._build_aliases_section(scroll)
        self._build_alias_browser(scroll)

        # Save / Cancel bar
        bar = ctk.CTkFrame(self, fg_color="transparent", height=56)
        bar.pack(fill="x", padx=16, pady=10)
        bar.pack_propagate(False)

        ctk.CTkButton(
            bar, text="Cancel",
            width=100, height=38,
            fg_color="transparent", border_width=1,
            command=self.destroy,
        ).pack(side="right", padx=(8, 0))

        ctk.CTkButton(
            bar, text="Save Upload Settings",
            width=180, height=38,
            fg_color=C_OK, hover_color="#16a34a",
            font=ctk.CTkFont(size=13, weight="bold"),
            command=self._save_upload,
        ).pack(side="right")

    # ── Upload settings (youtube.json) ───────────────────────────────────────

    def _build_upload_section(self, parent):
        ctk.CTkLabel(
            parent, text="📤  Upload Defaults",
            font=ctk.CTkFont(size=13, weight="bold"),
        ).pack(fill="x", padx=4, pady=(4, 4), anchor="w")

        ctk.CTkLabel(
            parent,
            text="Applied to every upload. Edit any field then click Save.",
            font=ctk.CTkFont(size=11), text_color=C_MUTED, anchor="w",
        ).pack(fill="x", padx=4, pady=(0, 6))

        card = ctk.CTkFrame(parent, fg_color=C_CARD, corner_radius=6)
        card.pack(fill="x", pady=4, padx=4)
        card.columnconfigure(1, weight=1)

        # Each _field call returns the next free row so we can never collide.
        r = 0
        self._daily_entry, r = self._field(
            card, r, "Daily upload limit:", str(self.yt_cfg.get("daily_limit", 6)),
            help_text="YouTube API default quota allows ~6 uploads/day.",
        )

        # Privacy (option menu — laid out manually but using the chained row counter)
        ctk.CTkLabel(
            card, text="Privacy:", anchor="e",
            font=ctk.CTkFont(size=12),
        ).grid(row=r, column=0, padx=(12, 8), pady=6, sticky="e")
        self._privacy_var = ctk.StringVar(value=self.yt_cfg.get("privacy", "public"))
        ctk.CTkOptionMenu(
            card, variable=self._privacy_var,
            values=self.PRIVACY_OPTIONS,
            width=160, height=28,
        ).grid(row=r, column=1, padx=8, pady=6, sticky="w")
        r += 1

        self._category_entry, r = self._field(
            card, r, "Category ID:", str(self.yt_cfg.get("category_id", "22")),
            help_text="22 = People & Blogs · 27 = Education · 29 = Nonprofits.",
        )

        # Made for kids (switch — also uses the row counter)
        ctk.CTkLabel(
            card, text="Made for kids:", anchor="e",
            font=ctk.CTkFont(size=12),
        ).grid(row=r, column=0, padx=(12, 8), pady=6, sticky="e")
        self._kids_var = ctk.BooleanVar(value=self.yt_cfg.get("made_for_kids", False))
        ctk.CTkSwitch(card, text="", variable=self._kids_var).grid(
            row=r, column=1, padx=8, pady=6, sticky="w"
        )
        r += 1

        self._tags_entry, r = self._field(
            card, r, "Tags:",
            ", ".join(self.yt_cfg.get("tags", [])),
            help_text="Comma-separated. Applied to every video.",
        )

        # Description (multi-line textbox)
        ctk.CTkLabel(
            card, text="Description:", anchor="ne",
            font=ctk.CTkFont(size=12),
        ).grid(row=r, column=0, padx=(12, 8), pady=6, sticky="ne")
        self._desc_box = ctk.CTkTextbox(
            card, height=90, fg_color=C_CARD2, corner_radius=4,
            font=ctk.CTkFont(size=11),
        )
        self._desc_box.grid(row=r, column=1, padx=8, pady=6, sticky="ew")
        if self.yt_cfg.get("description"):
            self._desc_box.insert("1.0", self.yt_cfg["description"])
        r += 1

        self._secret_entry, r = self._field(
            card, r, "OAuth secret file:",
            self.yt_cfg.get("client_secret_file", "client_secret.json"),
            help_text="Path (relative to script/) to the Google OAuth JSON. Default is fine.",
        )

        # bottom padding
        ctk.CTkLabel(card, text="").grid(row=r, column=0, pady=2)

    def _field(self, parent, row, label, value, help_text=None):
        """Build a labelled entry on `parent` grid at `row`. Returns (entry, next_free_row).

        Always returns the next available row so callers can chain without manually
        tracking which rows the help text consumed — eliminates grid collisions.
        """
        ctk.CTkLabel(
            parent, text=label, anchor="e", font=ctk.CTkFont(size=12),
        ).grid(row=row, column=0, padx=(12, 8), pady=(6, 0), sticky="e")

        entry = ctk.CTkEntry(parent, width=200, height=28, font=ctk.CTkFont(size=11))
        if value:
            entry.insert(0, value)
        entry.grid(row=row, column=1, padx=8, pady=(6, 0), sticky="w")

        next_row = row + 1
        if help_text:
            ctk.CTkLabel(
                parent, text=help_text,
                font=ctk.CTkFont(size=10), text_color=C_MUTED,
            ).grid(row=next_row, column=1, padx=8, pady=(0, 2), sticky="w")
            next_row += 1
        return entry, next_row

    def _save_upload(self):
        # Parse + validate fields
        try:
            daily = int(self._daily_entry.get().strip() or "6")
            if daily < 1 or daily > 100:
                raise ValueError("daily_limit out of range (1-100)")
        except ValueError as e:
            messagebox.showerror("Invalid daily limit", str(e), parent=self)
            return

        category = self._category_entry.get().strip() or "22"
        tags_raw = self._tags_entry.get().strip()
        tags = [t.strip() for t in tags_raw.split(",") if t.strip()] if tags_raw else []
        description = self._desc_box.get("1.0", "end").strip()

        secret_file = self._secret_entry.get().strip() or "client_secret.json"

        # Preserve unrelated fields (e.g. _gcloud_project written by --setup)
        self.yt_cfg["client_secret_file"] = secret_file
        self.yt_cfg["daily_limit"]        = daily
        self.yt_cfg["privacy"]            = self._privacy_var.get()
        self.yt_cfg["category_id"]        = category
        self.yt_cfg["made_for_kids"]      = self._kids_var.get()
        self.yt_cfg["tags"]               = tags
        self.yt_cfg["description"]        = description

        mv.save_youtube_config(self.yt_cfg)

        # Persist background config (enabled was already saved by toggle handler)
        try:
            interval = int(self._bg_interval_entry.get().strip() or "30")
            if interval < 1:
                interval = 1
        except ValueError:
            interval = 30
        self.bg_cfg["enabled"]                = self._bg_enabled_var.get()
        self.bg_cfg["check_interval_minutes"] = interval
        self.bg_cfg["start_on_login"]         = self._bg_login_var.get()
        mv.save_background_config(self.bg_cfg)

        # Install/uninstall the OS-level autostart entry to match the toggle
        try:
            currently_installed = mv.is_autostart_installed()
            if self._bg_login_var.get() and not currently_installed:
                mv.install_autostart()
            elif not self._bg_login_var.get() and currently_installed:
                mv.uninstall_autostart()
        except Exception as e:
            messagebox.showwarning(
                "Autostart",
                f"Could not update login-time startup entry:\n{e}",
                parent=self,
            )

        self.on_save()
        self.destroy()

    # ── Background / autostart ───────────────────────────────────────────────

    def _build_background_section(self, parent):
        ctk.CTkLabel(
            parent, text="🌙  Background Mode",
            font=ctk.CTkFont(size=13, weight="bold"),
        ).pack(fill="x", padx=4, pady=(20, 4), anchor="w")

        ctk.CTkLabel(
            parent,
            text="Run a watcher that polls your reciter folders and auto-uploads\n"
                 "new audio files as they appear, respecting the daily quota.",
            font=ctk.CTkFont(size=11), text_color=C_MUTED, justify="left",
        ).pack(fill="x", padx=4, pady=(0, 6))

        card = ctk.CTkFrame(parent, fg_color=C_CARD, corner_radius=6)
        card.pack(fill="x", pady=4, padx=4)
        card.columnconfigure(1, weight=1)

        r = 0

        # Run continuously toggle
        ctk.CTkLabel(
            card, text="Run continuously:", anchor="e",
            font=ctk.CTkFont(size=12),
        ).grid(row=r, column=0, padx=(12, 8), pady=(10, 4), sticky="e")
        self._bg_enabled_var = ctk.BooleanVar(value=self.bg_cfg.get("enabled", False))
        ctk.CTkSwitch(
            card, text="", variable=self._bg_enabled_var,
            command=self._on_enabled_toggled,
        ).grid(row=r, column=1, padx=8, pady=(10, 4), sticky="w")
        r += 1

        # Start on login toggle
        ctk.CTkLabel(
            card, text="Start on login:", anchor="e",
            font=ctk.CTkFont(size=12),
        ).grid(row=r, column=0, padx=(12, 8), pady=4, sticky="e")
        self._bg_login_var = ctk.BooleanVar(value=mv.is_autostart_installed())
        ctk.CTkSwitch(
            card, text="", variable=self._bg_login_var,
        ).grid(row=r, column=1, padx=8, pady=4, sticky="w")
        r += 1

        ctk.CTkLabel(
            card,
            text="(Installs an OS-level startup entry. Takes effect after next login.)",
            font=ctk.CTkFont(size=10), text_color=C_MUTED,
        ).grid(row=r, column=1, padx=8, pady=(0, 6), sticky="w")
        r += 1

        self._bg_interval_entry, r = self._field(
            card, r, "Check every (min):",
            str(self.bg_cfg.get("check_interval_minutes", 30)),
            help_text="How often the watcher scans for new files. Min 1.",
        )

        # Status row
        ctk.CTkLabel(
            card, text="Status:", anchor="e",
            font=ctk.CTkFont(size=12),
        ).grid(row=r, column=0, padx=(12, 8), pady=(10, 6), sticky="e")
        self._bg_status_lbl = ctk.CTkLabel(
            card, text="Checking…",
            font=ctk.CTkFont(size=12), anchor="w",
        )
        self._bg_status_lbl.grid(row=r, column=1, padx=8, pady=(10, 6), sticky="w")
        r += 1

        # Start/Stop buttons row
        btn_row = ctk.CTkFrame(card, fg_color="transparent")
        btn_row.grid(row=r, column=1, padx=4, pady=(2, 10), sticky="w")
        r += 1

        self._bg_start_btn = ctk.CTkButton(
            btn_row, text="▶  Start now",
            width=110, height=30,
            fg_color=C_OK, hover_color="#16a34a",
            font=ctk.CTkFont(size=11, weight="bold"),
            command=self._start_watcher_now,
        )
        self._bg_start_btn.pack(side="left", padx=4)

        self._bg_stop_btn = ctk.CTkButton(
            btn_row, text="■  Stop",
            width=80, height=30,
            fg_color="#7f1d1d", hover_color="#991b1b",
            font=ctk.CTkFont(size=11, weight="bold"),
            command=self._stop_watcher_now,
        )
        self._bg_stop_btn.pack(side="left", padx=4)

        ctk.CTkButton(
            btn_row, text="📋  View log",
            width=100, height=30,
            fg_color=C_CARD2,
            font=ctk.CTkFont(size=11),
            command=self._show_watcher_log,
        ).pack(side="left", padx=4)

        ctk.CTkLabel(card, text="").grid(row=r, column=0, pady=2)  # bottom padding

    def _on_enabled_toggled(self):
        # Persist immediately so the watcher loop can see the new state
        self.bg_cfg["enabled"] = self._bg_enabled_var.get()
        mv.save_background_config(self.bg_cfg)

    def _poll_watcher_status(self):
        """Refresh the live status label every 2s while the window is open."""
        try:
            pid = mv.watcher_pid()
        except Exception:
            pid = None

        if pid:
            self._bg_status_lbl.configure(
                text=f"● Running  (PID {pid})", text_color=C_OK,
            )
            self._bg_start_btn.configure(state="disabled")
            self._bg_stop_btn.configure(state="normal")
        else:
            self._bg_status_lbl.configure(
                text="○ Not running", text_color=C_MUTED,
            )
            self._bg_start_btn.configure(state="normal")
            self._bg_stop_btn.configure(state="disabled")

        # Re-poll while window is alive
        try:
            self.after(2000, self._poll_watcher_status)
        except Exception:
            pass  # window destroyed

    def _start_watcher_now(self):
        # Validate interval first and persist enabled+interval
        try:
            interval = int(self._bg_interval_entry.get().strip() or "30")
            if interval < 1:
                raise ValueError("must be at least 1 minute")
        except ValueError as e:
            messagebox.showerror("Invalid interval", str(e), parent=self)
            return

        self.bg_cfg["enabled"]                = True
        self.bg_cfg["check_interval_minutes"] = interval
        mv.save_background_config(self.bg_cfg)
        self._bg_enabled_var.set(True)

        # Refuse if already alive
        if mv.watcher_pid() is not None:
            messagebox.showinfo("Already running", "The watcher is already running.", parent=self)
            return

        # Ensure we have a usable token before launching a detached subprocess.
        # (The watcher fails silently if not authenticated.)
        if not mv.TOKEN_FILE.exists():
            messagebox.showerror(
                "Not authenticated",
                "Connect to YouTube on the first page before starting the watcher.",
                parent=self,
            )
            return

        # Spawn watcher in a fully detached process so it survives GUI close.
        script = str((Path(mv.__file__).resolve()))
        if sys.platform == "win32":
            CREATE_NEW_PROCESS_GROUP = 0x00000200
            DETACHED_PROCESS         = 0x00000008
            pyexe = str(mv._windows_pythonw())
            subprocess.Popen(
                [pyexe, script, "--watch"],
                creationflags=CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS,
                close_fds=True,
            )
        else:
            subprocess.Popen(
                [sys.executable, script, "--watch"],
                start_new_session=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                close_fds=True,
            )

        # Give it a moment to write its PID file before we re-poll
        self.after(500, self._poll_watcher_status)

    def _stop_watcher_now(self):
        """Graceful stop. Watcher checks for PID-file removal every 5s during sleep,
        and exits cleanly on the next tick. If it's mid-upload, it finishes that
        upload first so we never leave a half-uploaded video without a marker."""
        self.bg_cfg["enabled"] = False
        mv.save_background_config(self.bg_cfg)
        self._bg_enabled_var.set(False)

        if mv.watcher_pid() is None:
            return
        mv.WATCHER_PID_FILE.unlink(missing_ok=True)
        self.after(500, self._poll_watcher_status)

    def _show_watcher_log(self):
        lines = mv.read_watcher_log(last_n=300)
        dlg = ctk.CTkToplevel(self)
        dlg.title("Watcher Log")
        dlg.geometry("760x520")
        dlg.grab_set()

        ctk.CTkLabel(
            dlg, text=f"Last {len(lines)} log line(s)  ·  {mv.WATCHER_LOG_FILE}",
            font=ctk.CTkFont(size=12),
        ).pack(padx=12, pady=(10, 4), anchor="w")

        box = ctk.CTkTextbox(
            dlg, fg_color="#020617",
            font=ctk.CTkFont(size=11, family="Courier"),
        )
        box.pack(fill="both", expand=True, padx=10, pady=(0, 10))
        box.insert("end", "\n".join(lines) if lines else "(log empty)")
        box.configure(state="disabled")
        box.see("end")

    # ── Surah aliases (surahs.json) ──────────────────────────────────────────

    def _build_aliases_section(self, parent):
        ctk.CTkLabel(
            parent, text="📖  Add Surah Alias",
            font=ctk.CTkFont(size=13, weight="bold"),
        ).pack(fill="x", padx=4, pady=(20, 4), anchor="w")

        ctk.CTkLabel(
            parent,
            text="When a filename uses an unusual surah spelling (e.g. \"Thashr\"),\n"
                 "add it here so the program knows which Arabic name to use.",
            font=ctk.CTkFont(size=11), text_color=C_MUTED, justify="left",
        ).pack(fill="x", padx=4, pady=(0, 6))

        card = ctk.CTkFrame(parent, fg_color=C_CARD, corner_radius=6)
        card.pack(fill="x", pady=4, padx=4)
        card.columnconfigure(1, weight=1)

        ctk.CTkLabel(
            card, text="Spelling:", anchor="e",
            font=ctk.CTkFont(size=12),
        ).grid(row=0, column=0, padx=(12, 8), pady=(10, 6), sticky="e")
        self._alias_key_entry = ctk.CTkEntry(
            card, placeholder_text="e.g. Thashr", width=200, height=28,
            font=ctk.CTkFont(size=11),
        )
        self._alias_key_entry.grid(row=0, column=1, padx=8, pady=(10, 6), sticky="w")

        ctk.CTkLabel(
            card, text="Arabic name:", anchor="e",
            font=ctk.CTkFont(size=12),
        ).grid(row=1, column=0, padx=(12, 8), pady=6, sticky="e")
        self._alias_ar_entry = ctk.CTkEntry(
            card, placeholder_text="الحشر", width=200, height=28,
            font=ctk.CTkFont(size=11),
        )
        self._alias_ar_entry.grid(row=1, column=1, padx=8, pady=6, sticky="w")

        ctk.CTkButton(
            card, text="+ Add Alias",
            width=120, height=30,
            fg_color=C_UPLOAD, font=ctk.CTkFont(size=11, weight="bold"),
            command=self._add_alias,
        ).grid(row=2, column=1, padx=8, pady=(8, 12), sticky="w")

        # Recent additions feed
        self._recent_lbl = ctk.CTkLabel(
            parent, text="", font=ctk.CTkFont(size=11),
            text_color=C_OK, justify="left", anchor="w",
        )
        self._recent_lbl.pack(fill="x", padx=4, pady=(4, 8), anchor="w")

    def _add_alias(self):
        spelling = self._alias_key_entry.get().strip()
        arabic   = self._alias_ar_entry.get().strip()

        if not spelling:
            messagebox.showerror("Missing spelling", "Type the English/transliterated spelling.", parent=self)
            return
        if not arabic:
            messagebox.showerror("Missing Arabic name", "Type the Arabic surah name.", parent=self)
            return

        key = mv._surah_key(spelling)
        if not key:
            messagebox.showerror("Invalid spelling", "Spelling must contain at least one letter or digit.", parent=self)
            return

        self.surahs_dict[key] = arabic
        mv.save_surahs(self.surahs_dict)

        # Clear inputs and show in the recent feed
        self._alias_key_entry.delete(0, "end")
        self._alias_ar_entry.delete(0, "end")
        self._aliases_added_this_session.append((spelling, arabic, key))
        recent = "  ✓  " + "\n  ✓  ".join(
            f"{s}  →  {a}    (saved as: {k})"
            for s, a, k in self._aliases_added_this_session[-5:]
        )
        self._recent_lbl.configure(text=f"Added this session:\n{recent}")
        # Refresh the browser if it's been built
        if hasattr(self, "_alias_results"):
            self._refresh_alias_browser()

    # ── Browse / edit / delete existing aliases ──────────────────────────────

    def _build_alias_browser(self, parent):
        ctk.CTkLabel(
            parent, text="📚  Browse / Edit / Delete Aliases",
            font=ctk.CTkFont(size=13, weight="bold"),
        ).pack(fill="x", padx=4, pady=(20, 4), anchor="w")

        ctk.CTkLabel(
            parent,
            text=f"Search the {len(self.surahs_dict)} existing aliases by spelling or Arabic name.",
            font=ctk.CTkFont(size=11), text_color=C_MUTED,
        ).pack(fill="x", padx=4, pady=(0, 6))

        search_row = ctk.CTkFrame(parent, fg_color="transparent")
        search_row.pack(fill="x", padx=4, pady=(0, 6))

        self._alias_search = ctk.CTkEntry(
            search_row, placeholder_text="🔍  Type at least 2 characters…",
            height=30, font=ctk.CTkFont(size=12),
        )
        self._alias_search.pack(fill="x", expand=True, side="left")
        self._alias_search.bind("<KeyRelease>", lambda _e: self._refresh_alias_browser())

        self._alias_results = ctk.CTkFrame(parent, fg_color="transparent")
        self._alias_results.pack(fill="x", padx=4, pady=(0, 8))

        self._refresh_alias_browser()  # show empty-state hint

    def _refresh_alias_browser(self):
        for w in self._alias_results.winfo_children():
            w.destroy()

        query = self._alias_search.get().strip().lower()
        if len(query) < 2:
            ctk.CTkLabel(
                self._alias_results,
                text=f"  Type at least 2 letters to search.  ({len(self.surahs_dict)} aliases total)",
                font=ctk.CTkFont(size=11), text_color=C_MUTED, anchor="w",
            ).pack(fill="x", padx=4, pady=8)
            return

        matches = [
            (k, v) for k, v in sorted(self.surahs_dict.items())
            if query in k.lower() or query in v.lower()
        ]
        if not matches:
            ctk.CTkLabel(
                self._alias_results,
                text="  No matches.",
                font=ctk.CTkFont(size=11), text_color=C_MUTED, anchor="w",
            ).pack(fill="x", padx=4, pady=8)
            return

        cap = 30
        for key, arabic in matches[:cap]:
            self._alias_edit_row(key, arabic)

        if len(matches) > cap:
            ctk.CTkLabel(
                self._alias_results,
                text=f"  Showing first {cap} of {len(matches)} matches — refine your search to narrow down.",
                font=ctk.CTkFont(size=10), text_color=C_MUTED, anchor="w",
            ).pack(fill="x", padx=4, pady=(4, 6))

    def _alias_edit_row(self, key, arabic):
        row = ctk.CTkFrame(self._alias_results, fg_color=C_CARD, corner_radius=4)
        row.pack(fill="x", pady=2, padx=2)

        ctk.CTkLabel(
            row, text=key,
            font=ctk.CTkFont(size=11, family="Courier"),
            text_color="#cbd5e1", width=130, anchor="w",
        ).pack(side="left", padx=(10, 4), pady=5)

        ctk.CTkLabel(row, text="→", text_color=C_MUTED).pack(side="left")

        entry = ctk.CTkEntry(
            row, width=180, height=26, font=ctk.CTkFont(size=11),
        )
        entry.insert(0, arabic)
        entry.pack(side="left", padx=6, pady=4)

        ctk.CTkButton(
            row, text="Save", width=50, height=26,
            fg_color=C_OK, hover_color="#16a34a",
            font=ctk.CTkFont(size=10),
            command=lambda k=key, e=entry: self._save_alias_edit(k, e),
        ).pack(side="left", padx=2, pady=4)

        ctk.CTkButton(
            row, text="✕", width=28, height=26,
            fg_color="#7f1d1d", hover_color="#991b1b",
            font=ctk.CTkFont(size=11),
            command=lambda k=key: self._delete_alias(k),
        ).pack(side="left", padx=(2, 8), pady=4)

    def _save_alias_edit(self, key, entry):
        new_arabic = entry.get().strip()
        if not new_arabic:
            messagebox.showerror("Empty value", "Arabic name can't be empty. Use ✕ to delete instead.", parent=self)
            return
        self.surahs_dict[key] = new_arabic
        mv.save_surahs(self.surahs_dict)

    def _delete_alias(self, key):
        if not messagebox.askyesno(
            "Delete alias",
            f"Remove '{key}' from the alias dictionary?\n\n"
            f"Filenames using this spelling will no longer be auto-translated.",
            parent=self,
        ):
            return
        self.surahs_dict.pop(key, None)
        mv.save_surahs(self.surahs_dict)
        self._refresh_alias_browser()

class App(ctk.CTk):
    def __init__(self):
        super().__init__()
        self.title("Yoosy Joosy  ·  Upload Manager")
        self.geometry("980x700")
        self.minsize(840, 580)

        # ── State ─────────────────────────────────────────────────────────────
        self.youtube        = None
        self.yt_cfg         = mv.load_json(mv.YOUTUBE_CONFIG) if mv.YOUTUBE_CONFIG.exists() else {}
        self.reciters       = {}
        self.surahs_dict    = {}
        self.playlists_data = mv.load_playlists()
        self.scan_results     = []
        self._todo            = []
        self._uploading       = False
        self._upload_stop     = False
        self._scanning        = False  # guard against overlapping scan threads
        self._pending_prompted = False  # only nag about pending files once per session

        if mv.RECITERS_CONFIG.exists():
            self.reciters = mv.load_json(mv.RECITERS_CONFIG)
        else:
            mv.RECITERS_CONFIG.write_text("{}\n", encoding="utf-8")

        if mv.SURAHS_FILE.exists():
            self.surahs_dict = mv.load_json(mv.SURAHS_FILE)

        self._build_chrome()
        self.show_auth_page()

    # ── Chrome ────────────────────────────────────────────────────────────────

    def _build_chrome(self):
        # Header bar
        self.header = ctk.CTkFrame(self, height=52, corner_radius=0, fg_color=C_HEADER)
        self.header.pack(fill="x", side="top")
        self.header.pack_propagate(False)

        ctk.CTkLabel(
            self.header, text="🎵  Yoosy Joosy",
            font=ctk.CTkFont(size=15, weight="bold"),
        ).pack(side="left", padx=18)

        self.page_lbl = ctk.CTkLabel(
            self.header, text="",
            font=ctk.CTkFont(size=12), text_color=C_MUTED,
        )
        self.page_lbl.pack(side="left", padx=8)

        # Header buttons — always accessible
        self.settings_btn = ctk.CTkButton(
            self.header, text="⚙  Settings",
            width=100, height=32,
            font=ctk.CTkFont(size=12),
            fg_color=C_CARD, hover_color=C_CARD2,
            command=self.open_settings,
        )
        self.settings_btn.pack(side="right", padx=(4, 16))

        self.playlists_btn = ctk.CTkButton(
            self.header, text="🎵  Playlists",
            width=110, height=32,
            font=ctk.CTkFont(size=12),
            fg_color=C_CARD, hover_color=C_CARD2,
            command=self.open_playlist_manager,
        )
        self.playlists_btn.pack(side="right", padx=4)

        self.channel_lbl = ctk.CTkLabel(
            self.header, text="",
            font=ctk.CTkFont(size=12), text_color=C_MUTED,
        )
        self.channel_lbl.pack(side="right", padx=4)

        # Live watcher status (auto-refreshing)
        self.watcher_lbl = ctk.CTkLabel(
            self.header, text="",
            font=ctk.CTkFont(size=11), text_color=C_MUTED,
        )
        self.watcher_lbl.pack(side="right", padx=10)
        self._refresh_watcher_status()

        # Content
        self.content = ctk.CTkFrame(self, corner_radius=0, fg_color="transparent")
        self.content.pack(fill="both", expand=True)

        # Footer bar
        self.footer = ctk.CTkFrame(self, height=52, corner_radius=0, fg_color=C_HEADER)
        self.footer.pack(fill="x", side="bottom")
        self.footer.pack_propagate(False)

        self._fl = ctk.CTkFrame(self.footer, fg_color="transparent")
        self._fr = ctk.CTkFrame(self.footer, fg_color="transparent")
        self._fl.pack(side="left",  padx=12, pady=8)
        self._fr.pack(side="right", padx=12, pady=8)

    def _clear(self):
        for w in self.content.winfo_children(): w.destroy()
        for w in self._fl.winfo_children():     w.destroy()
        for w in self._fr.winfo_children():     w.destroy()

    def _set_page(self, text):
        self.page_lbl.configure(text=text)

    def _set_channel(self, text, color=C_MUTED):
        self.channel_lbl.configure(text=text, text_color=color)

    def open_playlist_manager(self):
        PlaylistWindow(
            self,
            reciters=self.reciters,
            playlists_data=self.playlists_data,
            surahs_dict=self.surahs_dict,
            youtube=self.youtube,
            on_save=self._reload_playlists,
        )

    def _reload_playlists(self):
        self.playlists_data = mv.load_playlists()
        self.reciters = mv.load_json(mv.RECITERS_CONFIG) if mv.RECITERS_CONFIG.exists() else {}

    def open_settings(self):
        SettingsWindow(
            self,
            yt_cfg=self.yt_cfg,
            surahs_dict=self.surahs_dict,
            on_save=self._reload_settings,
        )

    def _reload_settings(self):
        self.yt_cfg = mv.load_json(mv.YOUTUBE_CONFIG) if mv.YOUTUBE_CONFIG.exists() else {}
        if mv.SURAHS_FILE.exists():
            self.surahs_dict = mv.load_json(mv.SURAHS_FILE)

    def _refresh_watcher_status(self):
        """Update the header watcher indicator every 3s."""
        try:
            pid = mv.watcher_pid()
        except Exception:
            pid = None
        if pid:
            self.watcher_lbl.configure(text="🌙  watcher running", text_color=C_OK)
        else:
            self.watcher_lbl.configure(text="", text_color=C_MUTED)
        try:
            self.after(3000, self._refresh_watcher_status)
        except Exception:
            pass

    # ═════════════════════════════════════════════════════════════════════════
    # PAGE 1 — AUTH
    # ═════════════════════════════════════════════════════════════════════════

    def show_auth_page(self):
        self._clear()
        self._set_page("Step 1 of 3  ·  Connect YouTube")

        frame = ctk.CTkFrame(self.content, fg_color="transparent")
        frame.place(relx=0.5, rely=0.5, anchor="center")

        ctk.CTkLabel(frame, text="🔗", font=ctk.CTkFont(size=56)).pack(pady=(0, 6))
        ctk.CTkLabel(
            frame, text="Connect to YouTube",
            font=ctk.CTkFont(size=22, weight="bold"),
        ).pack()
        ctk.CTkLabel(
            frame,
            text="Authenticate with the Google account that owns your YouTube channel.",
            font=ctk.CTkFont(size=13), text_color=C_MUTED, justify="center",
        ).pack(pady=(6, 20))

        self._auth_dot = ctk.CTkLabel(
            frame, text="● Not connected",
            font=ctk.CTkFont(size=13), text_color=C_ERR,
        )
        self._auth_dot.pack(pady=(0, 4))

        self._auth_sub = ctk.CTkLabel(
            frame, text="", font=ctk.CTkFont(size=12), text_color=C_MUTED,
        )
        self._auth_sub.pack(pady=(0, 18))

        self._connect_btn = ctk.CTkButton(
            frame, text="Connect to YouTube",
            width=230, height=42,
            font=ctk.CTkFont(size=14, weight="bold"),
            command=self.do_connect,
        )
        self._connect_btn.pack()

        # Footer
        self._continue_btn = ctk.CTkButton(
            self._fr, text="Continue →",
            width=140, height=36,
            state="disabled",
            command=self.show_check_page,
        )
        self._continue_btn.pack()

        # Auto-verify if a token already exists
        if mv.TOKEN_FILE.exists():
            self._auth_dot.configure(text="● Verifying saved token…", text_color=C_WARN)
            threading.Thread(target=self._verify_token_thread, daemon=True).start()

    def _verify_token_thread(self):
        """Silently verify saved token (no browser flow). Pre-scans pending files on success."""
        try:
            from googleapiclient.discovery import build
            # interactive=False → never opens a browser; raises if token can't refresh
            creds = mv.get_credentials(self.yt_cfg, interactive=False)
            yt    = build("youtube", "v3", credentials=creds)
            items = yt.channels().list(part="snippet", mine=True).execute().get("items", [])
            if not items:
                raise RuntimeError("No channel found.")
            title = items[0]["snippet"]["title"]
            self.youtube = yt

            # Pre-scan so we can tell the user about pending files immediately.
            results = mv.scan_files(self.reciters, self.surahs_dict)
            self.scan_results = results
            pending = mv.collect_work(self.reciters, self.surahs_dict)
            self.after(0, self._on_auth_ok, title, len(pending))
        except Exception as e:
            self.after(0, self._on_auth_fail, str(e))

    def do_connect(self):
        self._connect_btn.configure(state="disabled", text="Opening browser…")
        self._auth_dot.configure(text="● Waiting for browser…", text_color=C_WARN)
        threading.Thread(target=self._auth_thread, daemon=True).start()

    def _auth_thread(self):
        try:
            from googleapiclient.discovery import build
            creds = mv.get_credentials(self.yt_cfg, interactive=True)
            yt    = build("youtube", "v3", credentials=creds)
            items = yt.channels().list(part="snippet", mine=True).execute().get("items", [])
            if not items:
                raise RuntimeError("No YouTube channel found.")
            title = items[0]["snippet"]["title"]
            self.youtube = yt
            self.after(0, self._on_auth_ok, title, None)
        except FileNotFoundError as e:
            # client_secret.json missing — guide the user to --setup
            self.after(0, self._on_auth_missing_secret, str(e))
        except Exception as e:
            self.after(0, self._on_auth_fail, str(e))

    def _on_auth_missing_secret(self, msg):
        self._on_auth_fail("client_secret.json not found")
        messagebox.showerror(
            "Setup needed",
            "client_secret.json is missing.\n\n"
            "Run this once in a terminal to set up Google Cloud:\n"
            "    python script/make_videos.py --setup\n\n"
            "Then come back and click Connect again.",
        )

    def _on_auth_ok(self, channel_title, n_pending=None):
        self._auth_dot.configure(text="● Connected", text_color=C_OK)
        self._auth_sub.configure(text=f"Channel: {channel_title}")
        self._connect_btn.configure(state="normal", text="Reconnect")
        self._continue_btn.configure(state="normal")
        self._set_channel(f"✓  {channel_title}", C_OK)

        # Offer shortcut to upload, but only once per session — don't re-prompt
        # when the user navigates Auth → Check → Back → Auth.
        if n_pending and not self._pending_prompted:
            self._pending_prompted = True
            self.after(200, lambda: self._prompt_pending(n_pending))

    def _prompt_pending(self, n_pending):
        if messagebox.askyesno(
            "Files ready to upload",
            f"{n_pending} file{'s' if n_pending != 1 else ''} pending upload.\n\n"
            "Review and upload now?",
        ):
            self.show_check_page()

    def _on_auth_fail(self, msg):
        self._auth_dot.configure(text="● Not connected", text_color=C_ERR)
        self._auth_sub.configure(text=msg[:90])
        self._connect_btn.configure(state="normal", text="Connect to YouTube")

    # ═════════════════════════════════════════════════════════════════════════
    # PAGE 2 — FILE CHECK
    # ═════════════════════════════════════════════════════════════════════════

    def show_check_page(self):
        self._clear()
        self._set_page("Step 2 of 3  ·  File Check")

        # Top bar
        topbar = ctk.CTkFrame(self.content, height=46, corner_radius=0, fg_color=C_CARD)
        topbar.pack(fill="x")
        topbar.pack_propagate(False)

        self._check_summary = ctk.CTkLabel(
            topbar, text="Scanning…",
            font=ctk.CTkFont(size=12), text_color=C_MUTED,
        )
        self._check_summary.pack(side="left", padx=16)

        self._autofix_btn = ctk.CTkButton(
            topbar, text="⚡ Auto-fix All",
            width=120, height=30,
            fg_color="#92400e", hover_color="#78350f",
            font=ctk.CTkFont(size=12),
            state="disabled",
            command=self.do_auto_fix_all,
        )
        self._autofix_btn.pack(side="right", padx=12, pady=8)

        self._check_scroll = ctk.CTkScrollableFrame(self.content, fg_color="transparent")
        self._check_scroll.pack(fill="both", expand=True, padx=10, pady=6)

        # Footer
        ctk.CTkButton(
            self._fl, text="← Back",
            width=100, height=36,
            fg_color="transparent", border_width=1,
            command=self.show_auth_page,
        ).pack()

        self._check_next_btn = ctk.CTkButton(
            self._fr, text="Continue to Upload →",
            width=195, height=36,
            state="disabled",
            command=self.show_upload_page,
        )
        self._check_next_btn.pack()

        threading.Thread(target=self._scan_thread, daemon=True).start()

    def _scan_thread(self):
        # Skip if another scan is already running — _save_arabic_name + nav can both trigger one
        if self._scanning:
            return
        self._scanning = True
        try:
            results = mv.scan_files(self.reciters, self.surahs_dict)
            self.scan_results = results
            self.after(0, self._render_check, results)
        finally:
            self._scanning = False

    def _render_check(self, results):
        for w in self._check_scroll.winfo_children():
            w.destroy()

        n_ok = n_warn = n_err = n_up = 0
        has_fixable = False

        for fd in results:
            # Folder header row
            hdr = ctk.CTkFrame(self._check_scroll, fg_color=C_CARD, corner_radius=6)
            hdr.pack(fill="x", pady=(8, 2), padx=2)

            label_color = "#e2e8f0"
            label_text  = f"📁  {fd['folder_name']}"
            if fd["name_ar"]:
                label_text += f"  ·  {fd['name_ar']}"
            else:
                label_text += "  ·  ⚠ No Arabic name"
                label_color = C_WARN

            ctk.CTkLabel(
                hdr, text=label_text,
                font=ctk.CTkFont(size=13, weight="bold"),
                text_color=label_color,
            ).pack(side="left", padx=12, pady=8)

            # Inline Arabic name input if missing
            if fd["missing_name_ar"]:
                ar_entry = ctk.CTkEntry(hdr, placeholder_text="Arabic name…", width=148, height=28)
                ar_entry.pack(side="right", padx=4, pady=6)
                ctk.CTkButton(
                    hdr, text="Save", width=54, height=28,
                    fg_color=C_OK, hover_color="#16a34a",
                    font=ctk.CTkFont(size=11),
                    command=lambda f=fd, e=ar_entry: self._save_arabic_name(f, e),
                ).pack(side="right", padx=(0, 8), pady=6)

            # No-image warning
            if not fd["has_image"]:
                wrow = ctk.CTkFrame(self._check_scroll, fg_color="#451a03", corner_radius=4)
                wrow.pack(fill="x", pady=1, padx=2)
                ctk.CTkLabel(
                    wrow,
                    text=f"  ⚠  No image found in  {fd['folder_name']}  — add a .jpg or .png for the video thumbnail",
                    text_color=C_WARN, font=ctk.CTkFont(size=11),
                ).pack(side="left", padx=8, pady=5)

            for fi in fd["files"]:
                st = fi["status"]
                if st == "uploaded":
                    n_up += 1
                    continue
                elif st == "ok":
                    n_ok += 1
                elif st == "warning":
                    n_warn += 1
                    if fi.get("suggestion"):
                        has_fixable = True
                elif st == "error":
                    n_err += 1
                self._file_row(fi).pack(fill="x", pady=1, padx=2)

        # Summary bar
        parts = []
        if n_ok:   parts.append(f"✓ {n_ok} OK")
        if n_warn: parts.append(f"⚠ {n_warn} warnings")
        if n_err:  parts.append(f"✗ {n_err} errors")
        if n_up:   parts.append(f"↑ {n_up} already uploaded")
        self._check_summary.configure(text="  ·  ".join(parts) or "No audio files found")

        self._autofix_btn.configure(state="normal" if has_fixable else "disabled")

        issues = n_warn + n_err
        tail   = f" ({issues} issue{'s' if issues != 1 else ''} remain)" if issues else ""
        self._check_next_btn.configure(
            state="normal",
            text=f"Continue to Upload{tail} →",
        )

    def _file_row(self, fi):
        st  = fi["status"]
        bg  = {"ok": "#052e16", "warning": "#422006", "error": "#450a0a"}.get(st, C_CARD)
        row = ctk.CTkFrame(self._check_scroll, fg_color=bg, corner_radius=4)
        col = STATUS_COLOR.get(st, C_MUTED)

        ctk.CTkLabel(
            row, text=STATUS_ICON.get(st, "·"),
            text_color=col,
            font=ctk.CTkFont(size=13, weight="bold"), width=20,
        ).pack(side="left", padx=(10, 4), pady=6)

        ctk.CTkLabel(
            row, text=fi["audio"].name,
            font=ctk.CTkFont(size=11, family="Courier"),
            text_color="#cbd5e1", anchor="w",
        ).pack(side="left", padx=4, pady=6, fill="x", expand=True)

        if fi.get("issue"):
            ctk.CTkLabel(
                row, text=fi["issue"],
                font=ctk.CTkFont(size=10), text_color=col, anchor="w",
            ).pack(side="left", padx=8, pady=6)

        if st == "warning" and fi.get("suggestion"):
            ctk.CTkButton(
                row, text="Fix", width=46, height=24,
                fg_color="#92400e", hover_color="#78350f",
                font=ctk.CTkFont(size=11),
                command=lambda f=fi, r=row: self._apply_fix(f, r, f["suggestion"]),
            ).pack(side="right", padx=(4, 8), pady=5)
        elif st == "error":
            entry = ctk.CTkEntry(row, placeholder_text="new filename…", width=210, height=26)
            entry.pack(side="right", padx=4, pady=5)
            ctk.CTkButton(
                row, text="Apply", width=56, height=26,
                fg_color="#7f1d1d", hover_color="#991b1b",
                font=ctk.CTkFont(size=11),
                command=lambda f=fi, r=row, e=entry: self._apply_entry_fix(f, r, e),
            ).pack(side="right", padx=(0, 8), pady=5)

        return row

    def _apply_fix(self, fi, row, new_name):
        audio    = fi["audio"]
        new_path = audio.parent / new_name
        if new_path.exists() and new_path != audio:
            messagebox.showwarning("Conflict", f"'{new_name}' already exists.")
            return
        try:
            audio.rename(new_path)
            fi["audio"]      = new_path
            fi["status"]     = "ok"
            fi["issue"]      = None
            fi["suggestion"] = None
            # _render_check will destroy & rebuild every row, so don't bother
            # mutating this row in place.
            self._render_check(self.scan_results)
        except Exception as e:
            messagebox.showerror("Rename failed", str(e))

    def _apply_entry_fix(self, fi, row, entry):
        name = entry.get().strip()
        if not name:
            return
        if not name.endswith(fi["audio"].suffix):
            name += fi["audio"].suffix
        self._apply_fix(fi, row, name)

    def _save_arabic_name(self, fd, entry):
        name_ar = entry.get().strip()
        if not name_ar:
            return
        fn = fd["folder_name"]
        if fn not in self.reciters:
            self.reciters[fn] = {}
        self.reciters[fn]["name_ar"] = name_ar
        fd["name_ar"]       = name_ar
        fd["missing_name_ar"] = False
        mv.save_reciters(self.reciters)
        threading.Thread(target=self._scan_thread, daemon=True).start()

    def do_auto_fix_all(self):
        count = 0
        for fd in self.scan_results:
            for fi in fd["files"]:
                if fi["status"] == "warning" and fi.get("suggestion"):
                    new_path = fi["audio"].parent / fi["suggestion"]
                    if not new_path.exists():
                        try:
                            fi["audio"].rename(new_path)
                            fi["audio"]      = new_path
                            fi["status"]     = "ok"
                            fi["issue"]      = None
                            fi["suggestion"] = None
                            count += 1
                        except Exception:
                            pass
        self._render_check(self.scan_results)
        if count:
            messagebox.showinfo("Auto-fix", f"Fixed {count} file(s).")

    # ═════════════════════════════════════════════════════════════════════════
    # PAGE 3 — UPLOAD
    # ═════════════════════════════════════════════════════════════════════════

    def show_upload_page(self):
        self._clear()
        self._set_page("Step 3 of 3  ·  Upload")
        self._uploading    = False
        self._upload_stop  = False

        # Reload playlist config in case user changed it
        self.playlists_data = mv.load_playlists()

        used        = mv.quota_used_today()
        daily_limit = self.yt_cfg.get("daily_limit", 6)
        remaining   = max(0, daily_limit - used)

        # Stats bar
        stats = ctk.CTkFrame(self.content, height=46, corner_radius=0, fg_color=C_CARD)
        stats.pack(fill="x")
        stats.pack_propagate(False)

        self._quota_lbl = ctk.CTkLabel(
            stats,
            text=f"Quota: {used}/{daily_limit} used today  ·  {remaining} remaining",
            font=ctk.CTkFont(size=13),
        )
        self._quota_lbl.pack(side="left", padx=20)

        todo = mv.collect_work(self.reciters, self.surahs_dict)
        self._todo = todo

        n_uploaded = sum(
            1 for fd in self.scan_results for fi in fd["files"] if fi["status"] == "uploaded"
        )
        ctk.CTkLabel(
            stats,
            text=f"Pending: {len(todo)}  ·  Uploaded: {n_uploaded}",
            font=ctk.CTkFont(size=13), text_color=C_MUTED,
        ).pack(side="right", padx=20)

        # Two-column pane
        pane = ctk.CTkFrame(self.content, fg_color="transparent")
        pane.pack(fill="both", expand=True, padx=10, pady=8)
        pane.columnconfigure(0, weight=3)
        pane.columnconfigure(1, weight=2)
        pane.rowconfigure(0, weight=1)

        self._build_pending_panel(pane, todo)
        self._build_log_panel(pane)
        self._build_progress_bar()

        # Footer
        ctk.CTkButton(
            self._fl, text="← Back",
            width=100, height=36,
            fg_color="transparent", border_width=1,
            command=self.show_check_page,
        ).pack()

        can_upload = bool(todo) and remaining > 0 and self.youtube is not None
        self._upload_btn = ctk.CTkButton(
            self._fr,
            text=f"⬆  Upload {min(len(todo), remaining)} video(s)" if can_upload else "Nothing to upload",
            width=210, height=36,
            fg_color=C_UPLOAD if can_upload else "#374151",
            state="normal" if can_upload else "disabled",
            font=ctk.CTkFont(size=13, weight="bold"),
            command=self.do_upload,
        )
        self._upload_btn.pack()

        # Initial log
        if not self.youtube:
            self._log("✗  Not authenticated — go back to step 1.")
        elif remaining == 0:
            self._log("Daily quota reached. Try again after midnight UTC.")
        elif not todo:
            self._log("✓  All files have been uploaded — nothing pending.")
        else:
            n_batch = min(len(todo), remaining)
            self._log(f"Ready.  {len(todo)} pending · {remaining} quota remaining · will upload {n_batch}.")
            # Show active playlist assignments
            p_data = self.playlists_data
            active_prayers = [p for p, c in p_data.get("prayers", {}).items() if c.get("enabled") and c.get("playlist_id")]
            active_surahs  = [s for s, c in p_data.get("surahs",  {}).items() if c.get("enabled") and c.get("playlist_id")]
            if active_prayers:
                self._log(f"Prayer playlists enabled: {', '.join(active_prayers)}")
            if active_surahs:
                self._log(f"Surah playlists enabled: {', '.join(active_surahs)}")

    def _build_pending_panel(self, pane, todo):
        left = ctk.CTkFrame(pane, fg_color=C_CARD2, corner_radius=8)
        left.grid(row=0, column=0, sticky="nsew", padx=(0, 5))

        ctk.CTkLabel(
            left, text=f"⏳  Pending  ({len(todo)})",
            font=ctk.CTkFont(size=13, weight="bold"),
        ).pack(padx=12, pady=(10, 4), anchor="w")

        scroll = ctk.CTkScrollableFrame(left, fg_color="transparent")
        scroll.pack(fill="both", expand=True, padx=6, pady=(0, 8))

        for item in todo:
            card = ctk.CTkFrame(scroll, fg_color=C_CARD, corner_radius=4)
            card.pack(fill="x", pady=3, padx=2)

            # File name
            ctk.CTkLabel(
                card, text=item["audio"].name,
                font=ctk.CTkFont(size=10, family="Courier"),
                anchor="w", text_color="#e2e8f0",
            ).pack(fill="x", padx=10, pady=(6, 1))

            # YouTube title preview
            if item["config"].get("name_ar"):
                title = mv.build_title(
                    item["config"]["name_ar"], item["parsed"], self.surahs_dict
                )
                ctk.CTkLabel(
                    card, text=title,
                    font=ctk.CTkFont(size=10), text_color=C_MUTED, anchor="w",
                ).pack(fill="x", padx=10, pady=(0, 6))

        if not todo:
            ctk.CTkLabel(
                scroll, text="✓  All files uploaded",
                font=ctk.CTkFont(size=13), text_color=C_OK,
            ).pack(pady=20)

    def _build_log_panel(self, pane):
        right = ctk.CTkFrame(pane, fg_color=C_CARD2, corner_radius=8)
        right.grid(row=0, column=1, sticky="nsew", padx=(5, 0))

        ctk.CTkLabel(
            right, text="📋  Log",
            font=ctk.CTkFont(size=13, weight="bold"),
        ).pack(padx=12, pady=(10, 4), anchor="w")

        self._log_box = ctk.CTkTextbox(
            right, fg_color="#020617", corner_radius=4,
            font=ctk.CTkFont(size=11, family="Courier"),
            state="disabled",
        )
        self._log_box.pack(fill="both", expand=True, padx=8, pady=(0, 8))

    def _build_progress_bar(self):
        pf = ctk.CTkFrame(self.content, height=36, fg_color=C_CARD, corner_radius=0)
        pf.pack(fill="x")
        pf.pack_propagate(False)

        self._progress = ctk.CTkProgressBar(pf, mode="determinate", height=6)
        self._progress.pack(fill="x", padx=12, pady=(8, 2))
        self._progress.set(0)

        self._progress_lbl = ctk.CTkLabel(
            pf, text="", font=ctk.CTkFont(size=10), text_color=C_MUTED,
        )
        self._progress_lbl.pack(pady=(0, 4))

    def _log(self, msg):
        ts = datetime.now().strftime("%H:%M:%S")
        self._log_box.configure(state="normal")
        self._log_box.insert("end", f"[{ts}]  {msg}\n")
        self._log_box.see("end")
        self._log_box.configure(state="disabled")

    def do_upload(self):
        if self._uploading:
            return
        self._uploading = True
        self._upload_btn.configure(state="disabled", text="Uploading…")
        threading.Thread(target=self._upload_thread, daemon=True).start()

    def _upload_thread(self):
        used        = mv.quota_used_today()
        daily_limit = self.yt_cfg.get("daily_limit", 6)
        remaining   = max(0, daily_limit - used)
        batch       = self._todo[:remaining]
        total       = len(batch)
        done        = 0

        for i, item in enumerate(batch):
            if self._upload_stop:
                break

            audio      = item["audio"]
            title      = mv.build_title(item["config"]["name_ar"], item["parsed"], self.surahs_dict)
            video_path = audio.with_suffix(".mp4")

            self.after(0, self._progress.set, i / total if total else 0)
            self.after(0, self._progress_lbl.configure,
                       {"text": f"[{i+1}/{total}]  {audio.name}"})

            # Encode
            if not video_path.exists():
                self.after(0, self._log, f"Encoding  {audio.name}…")
                try:
                    mv.make_video(audio, item["image"], video_path)
                except Exception as e:
                    self.after(0, self._log, f"✗  Encode error: {e}")
                    continue
            else:
                self.after(0, self._log, f"Reusing existing video for  {audio.name}")

            # Upload
            self.after(0, self._log, f"Uploading  {title}")
            try:
                video_id = mv.upload_video(self.youtube, video_path, title, self.yt_cfg)
                self.after(0, self._log, f"✓  youtu.be/{video_id}")
            except Exception as e:
                self.after(0, self._log, f"✗  Upload error: {e}")
                if "quota" in str(e).lower():
                    self.after(0, self._log, "Quota exhausted — stopping.")
                    break
                continue

            # Write marker BEFORE attempting playlists. A bad playlist ID must
            # not undo the upload — without this, retries would duplicate videos.
            item["marker"].write_text(
                json.dumps({
                    "video_id":    video_id,
                    "title":       title,
                    "uploaded_at": datetime.now(timezone.utc).isoformat(),
                }, ensure_ascii=False, indent=2)
            )
            mv.record_quota_use()
            done += 1

            # Add to all matching playlists — non-fatal, log per-playlist errors.
            for pid in mv.get_playlists_for_item(item, self.playlists_data):
                try:
                    mv.add_to_playlist(self.youtube, video_id, pid)
                    self.after(0, self._log, f"   → playlist  {pid}")
                except Exception as pe:
                    self.after(0, self._log, f"   ✗ playlist {pid} failed: {pe}")

        self.after(0, self._progress.set, 1.0)
        self.after(0, self._progress_lbl.configure,
                   {"text": f"Done — {done}/{total} uploaded"})
        self.after(0, self._log, f"─── Session complete: {done} of {total} uploaded ───")
        self.after(0, self._on_upload_done, done)

    def _on_upload_done(self, count):
        self._uploading = False
        used        = mv.quota_used_today()
        daily_limit = self.yt_cfg.get("daily_limit", 6)
        self._quota_lbl.configure(
            text=f"Quota: {used}/{daily_limit} used today  ·  {max(0, daily_limit - used)} remaining"
        )
        # Replace the upload button with a refresh — pending list, todo, and
        # quota all need recalculating before another batch.
        self._upload_btn.configure(
            text=f"↻  Refresh  (✓ {count} uploaded)",
            fg_color=C_OK, hover_color="#16a34a",
            state="normal",
            command=self.show_upload_page,
        )


# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    App().mainloop()
