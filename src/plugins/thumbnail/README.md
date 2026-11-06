# Thumbnail plugin

Renders the video still frame (1920×1080) and the YouTube thumbnail (1280×720) for a recording
from a small data-only job. **Imports nothing from `src/main` or `src/core`.** Full design:
`~/Projects/Yoosy Joosy/thumbnail-plugin-design.md`; feature spec: `thumbnail-spec.md` next to it.

## Contract (see `types.ts`)

```ts
import { render, dispose, manifest } from '@plugins/thumbnail'   // or a relative import

const result = await render(job, { outputDir, log })
// job:    { reciterNameAr, photoPath, surahsAr: string[], prayer: 'Isha', date: 'YYYY-MM-DD',
//           options: { sheikhPrefix: true, template: 'default' } }
// result: { ok: true, frame, thumbnail, cacheKey, cached }
//      or { ok: false, reason, message }     reason ∈ INVALID_JOB | PHOTO_UNREADABLE | UNKNOWN_SURAH |
//                                            UNKNOWN_PRAYER | BAD_DATE | FONT_NOT_LOADED | TEXT_OVERFLOW | RENDER_FAILED
```

- Runs in the **main process** (it needs a hidden Chromium window). One window is kept open and
  reused; call `dispose()` on app quit.
- Output goes only to `outputDir`. Files are `<cacheKey>.frame.jpg` and `<cacheKey>.thumb.jpg`;
  a job whose files already exist returns instantly with `cached: true`.
- Every failure is a reason + a sentence for the user, never a thrown error.

## Integration notes for the app (not done yet — decided with Umo)

1. **Where to call it** — `src/main/pipeline.ts`: before `encodeVideo`, build the job from the
   record + reciter and call `render`. `ok` → encode with `result.frame`; not ok → warn on the record
   (reason + message) and encode with the plain reciter photo as today. **Never block the upload.**
   After the `.uploaded` marker is written: `thumbnails.set` with `result.thumbnail` (non-fatal,
   like playlists; 50 quota units, count it).
2. **Job fields come from existing data**: `reciter.nameAr`, `reciter.imagePath`,
   `record.parsed.surahs.map(translateSurah)`, `record.parsed.prayer`, `record.parsed.date`
   (DD.MM.YYYY → YYYY-MM-DD).
3. **`outputDir`** = `<library>/.yoosyjoosy/thumbs` (travels with the library).
4. **Settings**: `settings.thumbnails = { enabled: true, sheikhPrefix: true }` — **on by default**,
   ships with the next update; a toggle turns it off (then the pipeline behaves exactly as before).
5. **ffmpeg**: output 1920×1080 when the frame is 1080p (`src/main/ffmpeg.ts` scale/pad filter).
6. **Packaging**: `electron-builder.yml` already copies `template/` to `resources/thumbnail`;
   `renderer.ts` resolves it there when packaged, from the repo in dev.
7. **Template changes**: bump `manifest.templateVersion` in `index.ts` so cached renders refresh.

## Working on the template without the app

```bash
npm run build
npm run thumb -- src/plugins/thumbnail/samples/jobs.json /tmp/thumbs
```

`samples/jobs.json` holds three good jobs and two deliberately bad ones (unknown surah, missing
photo). Edit `template/thumbnail.html`, rebuild, re-run. The template is the locked design from
2026-11-06: reciter on top, calligraphy, prayer · date; two surahs on one row without «سورة».

## Tests

`npm test` runs `job.test.ts` and `cache.test.ts` (no Electron): the 114-surah table matches the
app dictionary and resolves every alias, prayer wording matches the app, Hijri dates against
real recordings, every validation reason, cache-key stability. Rendering is checked with the CLI.
