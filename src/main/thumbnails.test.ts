import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false }, BrowserWindow: class {}, nativeImage: {} }))
import { DEFAULT_SURAHS } from '@core/surahs'
import { buildThumbnailJob, fontPathsInRules, isoDate, styleForRecord } from './thumbnails'
import { WORST_CASE_SAMPLE } from '@core/thumb-rules'
import { WORST_CASE } from '../plugins/thumbnail/index'

const opts = { enabled: true, sheikhPrefix: true }
describe('thumbnail job builder', () => {
  it('converts the filename date and translates surah spellings', () => {
    expect(isoDate('5.2.2025')).toBe('2025-02-05')
    const r = buildThumbnailJob({ fileName: 'x', parsed: { date: '23.12.2024', prayer: 'Isha', reciter: null, surahs: ['Dukhan', 'Thariat'], keywords: [] } },
      { nameAr: 'عبدالله الموسى', imagePath: '/p/photo.jpg' }, DEFAULT_SURAHS, opts)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.job).toEqual({ reciterNameAr: 'عبدالله الموسى', photoPath: '/p/photo.jpg', surahsAr: ['الدخان', 'الذاريات'], prayer: 'Isha', date: '2024-12-23', options: { sheikhPrefix: true, template: 'default' } })
  })
  it('explains missing name / photo / parse', () => {
    expect(buildThumbnailJob({ fileName: 'x', parsed: null }, { nameAr: 'a', imagePath: '/p' }, DEFAULT_SURAHS, opts)).toMatchObject({ ok: false, reason: 'INVALID_JOB' })
    expect(buildThumbnailJob({ fileName: 'x', parsed: { date: '1.1.2025', prayer: 'Fajr', reciter: null, surahs: ['Mulk'], keywords: [] } }, { nameAr: null, imagePath: '/p' }, DEFAULT_SURAHS, opts)).toMatchObject({ ok: false, reason: 'INVALID_JOB' })
    expect(buildThumbnailJob({ fileName: 'x', parsed: { date: '1.1.2025', prayer: 'Fajr', reciter: null, surahs: ['Mulk'], keywords: [] } }, { nameAr: 'a', imagePath: null }, DEFAULT_SURAHS, opts)).toMatchObject({ ok: false, reason: 'PHOTO_UNREADABLE' })
  })
  it('attaches the style the rules resolve, and omits it when there is none', () => {
    const parsed = { date: '1.1.2025', prayer: 'Taraweeh', reciter: null, surahs: ['Mulk'], keywords: [] }
    const rules = [{ id: 't', enabled: true, conditions: [{ kind: 'prayer' as const, value: 'Taraweeh', negate: false }], style: { frame: { width: 4 } }, sample: { folder: '', surahsAr: ['الملك'], prayer: 'Isha', date: '2025-01-01' } }]
    const rec = { reciterKey: 'x', tokens: { prayer: 'Taraweeh', surahs: ['Mulk'], keywords: [], leftovers: [], date: null, dateDirty: false, reciter: null }, playlists: { auto: [], final: [] } }
    const { base: rule, style } = styleForRecord(rec, rules, DEFAULT_SURAHS)
    expect(rule?.id).toBe('t')
    const r = buildThumbnailJob({ fileName: 'x', parsed }, { nameAr: 'a', imagePath: '/p' }, DEFAULT_SURAHS, opts, style)
    expect(r.ok && r.job.style).toEqual({ frame: { width: 4 } })
    const none = buildThumbnailJob({ fileName: 'x', parsed }, { nameAr: 'a', imagePath: '/p' }, DEFAULT_SURAHS, opts, styleForRecord({ ...rec, tokens: { ...rec.tokens, prayer: 'Isha' } }, rules, DEFAULT_SURAHS).style)
    expect(none.ok && !('style' in none.job)).toBe(true)
  })
  it('a rule photo replaces the reciter photo in the job', () => {
    const parsed = { date: '1.1.2025', prayer: 'Fajr', reciter: null, surahs: ['Mulk'], keywords: [] }
    const r = buildThumbnailJob({ fileName: 'x', parsed }, { nameAr: 'a', imagePath: '/p/reciter.jpg' }, DEFAULT_SURAHS, opts, undefined, '/lib/.yoosyjoosy/thumb-photos/rule-1.png')
    expect(r.ok && r.job.photoPath).toBe('/lib/.yoosyjoosy/thumb-photos/rule-1.png')
    const noPhotoReciter = buildThumbnailJob({ fileName: 'x', parsed }, { nameAr: 'a', imagePath: null }, DEFAULT_SURAHS, opts, undefined, '/lib/x.png')
    expect(noPhotoReciter.ok && noPhotoReciter.job.photoPath).toBe('/lib/x.png')
  })
  it('collects custom font paths from rules, ignoring bundled ids', () => {
    const mk = (style: object) => ({ id: 'x', enabled: true, conditions: [], style, sample: { folder: '', surahsAr: ['x'], prayer: 'Isha', date: '2025-01-01' } })
    const paths = fontPathsInRules([mk({ reciter: { font: '/lib/.yoosyjoosy/fonts/a.ttf' }, meta: { font: 'amiri' } }), mk({ meta: { font: '/lib/.yoosyjoosy/fonts/b.otf' } }), mk({})])
    expect([...paths].sort()).toEqual(['/lib/.yoosyjoosy/fonts/a.ttf', '/lib/.yoosyjoosy/fonts/b.otf'])
  })
  it("the editor's worst-case sample is the plugin's own worst case", () => {
    expect(WORST_CASE_SAMPLE).toEqual({ surahsAr: WORST_CASE.surahsAr, prayer: WORST_CASE.prayer, date: WORST_CASE.date })
  })
})

describe('pruneDefaultLook', () => {
  it('drops Default look knobs that equal the plugin factory value and leaves other rules alone', async () => {
    const { pruneDefaultLook } = await import('./thumbnails')
    const { DEFAULT_STYLE } = await import('../plugins/thumbnail/index')
    const rules = [
      { id: 'x', enabled: true, conditions: [], style: { photo: { blur: DEFAULT_STYLE.photo.blur } }, sample: { folder: 'A', surahsAr: ['x'], prayer: 'Isha', date: '2025-01-01' } },
      { id: 'default', origin: 'default', enabled: true, conditions: [], style: { photo: { blur: DEFAULT_STYLE.photo.blur, contrast: DEFAULT_STYLE.photo.contrast + 0.2 }, title: { scale: DEFAULT_STYLE.title.scale } }, sample: { folder: 'A', surahsAr: ['x'], prayer: 'Isha', date: '2025-01-01' } },
    ] as never
    const out = pruneDefaultLook(rules)
    expect(out[0]!.style).toEqual({ photo: { blur: DEFAULT_STYLE.photo.blur } })
    expect(out[1]!.style).toEqual({ photo: { contrast: DEFAULT_STYLE.photo.contrast + 0.2 } })
  })
})

describe('look files: pack and unpack', () => {
  it('embeds custom fonts on export and restores them, drops unknown knobs, and reports both', async () => {
    const { mkdtemp, writeFile, readFile, readdir } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { packLook, unpackLook } = await import('./thumbnails')
    const src = await mkdtemp(join(tmpdir(), 'look-src-'))
    const lib = await mkdtemp(join(tmpdir(), 'look-lib-'))
    const fontPath = join(src, 'MyFont.ttf')
    await writeFile(fontPath, Buffer.from('not really a font'))
    const rule = { label: 'Night', overlay: false, style: { reciter: { font: fontPath, scale: 1.2 } } } as never
    const file = await packLook(rule, { reciter: { font: fontPath, scale: 1.2 }, title: { scale: 0.9 } }, '3.2.2')
    expect(file.fonts?.[fontPath]).toEqual({ name: 'MyFont.ttf', data: Buffer.from('not really a font').toString('base64') })
    // simulate another machine: the original path is gone, and the file carries a knob this plugin doesn't know
    const text = JSON.stringify({ ...file, knobs: { ...file.knobs, future: { thing: 1 } } }).replaceAll(fontPath, '/elsewhere/MyFont.ttf')
    const out = await unpackLook(text, lib)
    const restored = (await readdir(join(lib, '.yoosyjoosy', 'fonts')))[0]!
    expect(restored).toMatch(/^MyFont-\d+\.ttf$/)
    expect(await readFile(join(lib, '.yoosyjoosy', 'fonts', restored), 'utf8')).toBe('not really a font')
    expect(out.file.knobs).toEqual({ reciter: { font: join(lib, '.yoosyjoosy', 'fonts', restored), scale: 1.2 } })
    expect(out.file.look).toEqual({ reciter: { font: join(lib, '.yoosyjoosy', 'fonts', restored), scale: 1.2 }, title: { scale: 0.9 } })
    expect(out.notes).toEqual(['Font “MyFont.ttf” restored into the library.', 'Skipped a knob this version doesn\'t have: future (unknown knob).'])
    // a font path that is neither embedded nor present → that knob is dropped with a note
    const missing = await unpackLook(JSON.stringify({ format: 'yoosy-joosy.thumbnail-look', version: 1, knobs: { meta: { font: '/gone/Font.otf', scale: 1.1 } } }), lib)
    expect(missing.file.knobs).toEqual({ meta: { scale: 1.1 } })
    expect(missing.notes[0]).toMatch(/Font file “Font.otf” isn't on this computer/)
  })
})
