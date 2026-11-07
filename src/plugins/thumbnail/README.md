# Thumbnail plugin

Renders the video still frame (1920×1080) and the YouTube thumbnail (1280×720) for a recording
from a small data-only job, with an optional **style** that changes the look. **Imports nothing
from `src/main` or `src/core`.** Design docs: `~/Projects/Yoosy Joosy/thumbnail-plugin-design.md`,
`thumbnail-style-design.md`, feature spec `thumbnail-spec.md`.

## Contract (see `types.ts`)

```ts
import { render, dispose, manifest, validateStyle, STYLE_SCHEMA, STYLE_FIELDS, DEFAULT_STYLE } from '../plugins/thumbnail'

const result = await render(job, { outputDir, log })
// job:    { reciterNameAr, photoPath, surahsAr: string[], prayer: 'Isha', date: 'YYYY-MM-DD',
//           options: { sheikhPrefix: true, template: 'default' },
//           style?: { ...any subset of knobs, grouped... } }
// result: { ok: true, frame, thumbnail, cacheKey, cached, warnings, layout? }
//      or { ok: false, reason, message }
//         reason ∈ INVALID_JOB | INVALID_STYLE | PHOTO_UNREADABLE | UNKNOWN_SURAH | UNKNOWN_PRAYER |
//                  BAD_DATE | FONT_NOT_LOADED | TEXT_OVERFLOW | RENDER_FAILED
```

- Runs in the **main process** (hidden Chromium window, kept open and reused); call `dispose()` on quit.
- Writes only to `outputDir`: `<cacheKey>.frame.jpg` + `<cacheKey>.thumb.jpg`. Same job + same
  style = same key; existing files return instantly with `cached: true`.
- Every failure is a reason + a sentence for the user. Never a thrown error.

## Style

An optional `style` object on the job. **Every knob is optional**; a missing knob takes the factory
default — since plugin 1.4.0 (styleVersion 3) that is Umo's Default look, so `style: {}` (or no style)
renders exactly it with no rule edits (checked by the golden test). Knobs are grouped, all numbers are decimals with a tested min/max, colours are strings from a
colour picker (`#RGB`, `#RRGGBB`, `#RRGGBBAA`, `rgb()`, `rgba()`).

`samples/style-template.json` is the full request template with every knob at its default — copy
it, delete what you don't change. `STYLE_SCHEMA` / `STYLE_FIELDS` carry the same information with
min, max, step and a description per knob, for building sliders.

| Group | Knobs |
|---|---|
| `photo` | focusX, focusY (0–100), zoom (1–2.5), blur (0–16), brightness (0.2–1.6), contrast (0.5–1.6), saturation (0–2), hue (0–360), sepia (0–1), grain (0–1) |
| `overlay` | color, top / middle / bottom (0–1), angle (0–360), vignetteStrength (0–1.5), vignetteSize (50–150), scrimStrength (0–1.5), scrimSize (20–100) |
| `text` | offsetX (−250–250), offsetY (−120–120, negative = up), width (0.5–0.95), gapAboveTitle, gapBelowTitle (0–90) |
| `shadow` | color, opacity (0–1), blur (0–40), offsetY (−20–20) — shared by all text |
| `title` | color, gradient (0–1), gradientAngle, scale (0.5–1.15), opacity, glow (0–2), glowColor, glowSize (0–60), outlineWidth (0–6), outlineColor, surahWordScale (0–1.2; 0 hides «سورة»), surahWordGap (0–0.4 em), joinScale (0.2–0.6) |
| `reciter` | **font**, color, scale (0.5–1.6), opacity (0 hides the line), letterSpacing (−0.05–0.3 em), pill { opacity, color, radius, paddingX, paddingY } |
| `meta` | **font**, color, scale (0.5–1.6), opacity, prayerOpacity, dateOpacity (0 hides), letterSpacing, gap (0.1–1.5 em), separatorColor, separatorSize (0–16; 0 hides), pill {…} |
| `dividers` | aboveTitle / belowTitle { opacity (0 = hidden), width (40–800), thickness (1–8), color } — a gap applies on both sides of a visible divider |
| `frame` | width (0–40; 0 = none), color, opacity, inset (0–60), radius (0–40) |
| `output` | quality (60–100) |

### Fonts (`reciter.font`, `meta.font`)

A value is either a **bundled font id** or an **absolute path** to the user's own `.ttf` / `.otf` /
`.woff` / `.woff2`. Defaults: `tajawal` (reciter) and `reem-kufi` (prayer · date) = the Default look; `amiri` + `ibm-plex-sans-arabic` were the original locked
look. The surah calligraphy font is fixed. `BUNDLED_FONTS` (exported) carries id, label, style tag and
files for pickers; `STYLE_FIELDS` entries of kind `font` list the same ids under `options`.

Bundled (all SIL OFL, licences in `template/fonts/licences/`): `amiri`, `ibm-plex-sans-arabic`,
`scheherazade-new`, `noto-naskh-arabic`, `lateef`, `harmattan`, `markazi-text`, `aref-ruqaa`, `katibeh`,
`mirza`, `gulzar`, `reem-kufi`, `noto-kufi-arabic`, `cairo`, `tajawal`, `almarai`, `el-messiri`,
`changa`, `lalezar`, `rakkas`, `vibes`. See `~/Projects/Yoosy Joosy/thumbnail-preview/fonts/` for how
each looks on a thumbnail.

Custom files: the plugin loads the file in the render window, checks it actually draws Arabic (a
Latin-only font is refused), and includes the file's size + mtime in the cache key so a replaced file
re-renders. Problems come back as `FONT_NOT_LOADED` with the line and file named. Weight: bundled fonts
use their own bold for the reciter line where the family has one; single-weight fonts are never
faux-bolded (`font-synthesis: none`); custom files are requested at 700 / 500.

Rules the plugin enforces, whatever the knobs say:
- **Validation first.** Unknown key, wrong type, out-of-range number or bad colour → `INVALID_STYLE`
  listing every problem by dotted key. Nothing is clamped silently. `validateStyle(patch)` is exported
  so the app can check while sliders move.
- **Shrink-to-fit works at two levels.** Each line fits its own box (boxes never exceed the room
  inside the safe margin); if the group is still wider or taller than the room, every line plus the
  gaps, pills and dividers scale down together (`fit.group`). Only when that would go below 55% is
  the render refused (`TEXT_OVERFLOW`, saying what ratio it would have needed). `warnings` says how
  much shrank; `layout.fit` has the effective ratio per line.
- **Safe area.** The text group is kept ≥ 24 px from the edge (more when a frame is drawn). Offsets
  that would push it out are pulled back (reported in `warnings`).
- **Fonts are fixed.** The calligraphy font breaks with letter-spacing, so none is offered on the title.

## Capture correctness (stale frames, zoom, display scaling)

On an offscreen window, `capturePage` returns the most recent *composited* frame, and even the
first `paint` after `invalidate()` can be a frame that was already in flight. After the hidden
window has sat idle (every recording in an upload run follows an idle gap) a timer-based capture
could return the previous job's picture, which then got cached under the new key.

**Stamp.** Every render paints its id into two 6×6 template-px blocks at the bottom-right corner
as the **last** DOM change — the id's colour, then its complement (`stamp.ts`: 2 bits per channel at
levels {0, 85, 170, 255}, 63 ids, decoded by nearest level with ±40 tolerance so colour management
or dithering cannot lose it; black = "no stamp"). `renderer.captureStamped` accepts a frame only when
both blocks decode to the current id, forcing repaints until one does, then scrubs the pixels.

**Zoom and size are verified, never assumed.** The hidden window has its own in-memory session
(`partition: 'thumbnail'`): Chromium keeps zoom per origin *and per session*, and the app window is
the same `file://` origin, so without this a user zooming the app re-zoomed the template (seen on
Windows 3.0.x: stamp off the corner, every render refused). After each render the template reports
`innerWidth/innerHeight`, `devicePixelRatio` and the stamp's rect; if the viewport is not 1280×720
CSS px with the stamp ending at (1280, 720), the plugin resets zoom 1.5 and the 1920×1080 content
size, waits for the page to see them, and renders again — failing with the measured values only if
that does not help. The template root is `overflow: hidden` so a rounding pixel can never grow a
scrollbar. `devicePixelRatio` is reported but not required to be 1.5: under Windows display scaling
it is 1.5 × scale and frames arrive at e.g. 2400×1350; the stamp is read at the scaled position and
the frame is downscaled to 1920×1080 after scrubbing.

**Fallback.** If no stamped frame arrives within 3 s but the last two paints are byte-identical *and*
differ both from what the window showed before the render and from the previous render's frame, that
frame is stable and new and is used with the warning "Render stamp not readable on this machine —
frame accepted because it is stable and new." A frame identical to the previous render's is never
returned. Failure messages carry the diagnostics: paint count, last frame size, raw BGRA at the two
sample points, content size, zoom factor, primary display scale, platform and the page measurements;
`THUMB_DEBUG=1` logs the same once per window creation and per paint.

Checks: `npm run thumb:hostile` (zoom 1.0 + 1600×900 resize between renders must still match the
golden; a hidden stamp must fall back to a fresh picture with the warning and refuse the previous
picture; a normal render afterwards carries no warning), `npm run thumb -- --idle 390 /tmp/t` (job A,
6.5 min idle, job B: B's pixels must differ from A's), `stamp.test.ts` (every id decodes after ±30
per channel at 1080p and under 125/150/175 % scaling; black, uniform regions and a wrong complement
are refused).

`WORST_CASE` (exported) is the content the sweep uses — the widest surah pair, longest prayer and
month, longest name — so an editor can offer the same preview.

## Integration notes for the app

1. Build the job from existing data (`reciter.nameAr`, `reciter.imagePath`, `parsed.surahs` → Arabic,
   `parsed.prayer`, `parsed.date` → YYYY-MM-DD) and attach whatever `style` the app's rules resolve
   for that clip, or none.
2. `outputDir` = `<library>/.yoosyjoosy/thumbs`. Style is in the cache key, so a changed style re-renders.
3. A thumbnail failure never blocks an upload: warn with the reason, encode with the plain photo.
4. After a template change bump `manifest.templateVersion`; after a knob/range change bump `styleVersion`.

## Working on it without the app

```bash
npm run build
npm run thumb -- src/plugins/thumbnail/samples/jobs.json /tmp/thumbs   # 4 good jobs (one styled) + 2 bad ones
npm run thumb:golden     # empty style must reproduce samples/golden/*.jpg (mean diff < 1.5)
npm run thumb:sweep      # worst-case job × every knob at min/max + combos; asserts bounds (173 renders)
npm run thumb -- --idle 390 /tmp/thumb-idle   # stale-capture check (6.5 min idle between two renders)
npm run thumb:hostile    # zoom/size drift and an unreadable stamp must still give fresh pictures
```

After any template change: run the golden check (should still match unless you meant to change the
look — then re-capture the goldens and bump `templateVersion`) and the sweep.

## Tests

`npm test`: surah table matches the app dictionary and resolves every alias; prayer wording matches
the app; Hijri dates against real recordings; every validation reason; every knob's min/max accepted
and one step beyond rejected by key; colour formats; defaults reproduce the Default look's CSS values;
cache keys ignore style key order; `style-template.json` equals the schema defaults.
