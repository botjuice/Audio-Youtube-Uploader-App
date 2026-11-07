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

An optional `style` object on the job. **Every knob is optional**; a missing knob takes the locked
design's default, so `style: {}` (or no style) renders exactly today's look (checked by the golden
test). Knobs are grouped, all numbers are decimals with a tested min/max, colours are strings from a
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
| `reciter` | color, scale (0.5–1.6), opacity (0 hides the line), letterSpacing (−0.05–0.3 em), pill { opacity, color, radius, paddingX, paddingY } |
| `meta` | color, scale (0.5–1.6), opacity, prayerOpacity, dateOpacity (0 hides), letterSpacing, gap (0.1–1.5 em), separatorColor, separatorSize (0–16; 0 hides), pill {…} |
| `dividers` | aboveTitle / belowTitle { opacity (0 = hidden), width (40–800), thickness (1–8), color } — a gap applies on both sides of a visible divider |
| `frame` | width (0–40; 0 = none), color, opacity, inset (0–60), radius (0–40) |
| `output` | quality (60–100) |

Rules the plugin enforces, whatever the knobs say:
- **Validation first.** Unknown key, wrong type, out-of-range number or bad colour → `INVALID_STYLE`
  listing every problem by dotted key. Nothing is clamped silently. `validateStyle(patch)` is exported
  so the app can check while sliders move.
- **Shrink-to-fit** still runs per line; below 55% the render is refused (`TEXT_OVERFLOW`).
- **Safe area.** The text group is kept ≥ 24 px from the edge (more when a frame is drawn). Offsets
  that would push it out are pulled back (reported in `warnings`); a group taller or wider than the
  safe area is refused with `TEXT_OVERFLOW` naming the knobs to reduce.
- **Fonts are fixed.** The calligraphy font breaks with letter-spacing, so none is offered on the title.

## Capture correctness (stale-frame bug, fixed 2026-11-07)

On an offscreen window, `capturePage` returns the most recent *composited* frame, and even the
first `paint` after `invalidate()` can be a frame that was already in flight. After the hidden
window has sat idle (every recording in an upload run follows an idle gap) the old timer-based
capture could return the previous job's picture, which then got cached under the new key.

Fix: every render paints a colour-coded render id into a 2px corner stamp as the **last** DOM
change, and the renderer accepts a frame only when its stamp matches (`renderer.captureStamped`),
forcing repaints until one does; the stamp pixels are scrubbed from the output. `templateVersion`
was bumped to 3 so existing caches re-render. Check: `npm run thumb -- --idle 390 /tmp/t` renders
job A, idles 6.5 min, renders job B, and fails if B's pixels equal A's. Set `THUMB_DEBUG=1` to see
each paint's stamp.

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
npm run thumb:sweep      # worst-case job × every knob at min/max + combos; asserts bounds (147 renders)
npm run thumb -- --idle 390 /tmp/thumb-idle   # stale-capture check (6.5 min idle between two renders)
```

After any template change: run the golden check (should still match unless you meant to change the
look — then re-capture the goldens and bump `templateVersion`) and the sweep.

## Tests

`npm test`: surah table matches the app dictionary and resolves every alias; prayer wording matches
the app; Hijri dates against real recordings; every validation reason; every knob's min/max accepted
and one step beyond rejected by key; colour formats; defaults reproduce the locked CSS values;
cache keys ignore style key order; `style-template.json` equals the schema defaults.
