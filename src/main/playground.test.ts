import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false }, BrowserWindow: class {}, nativeImage: {} }))
import { buildSampleJob, styleProblems, styleSchema, surahOptions } from './thumbnails'

const rec = { nameAr: 'عبدالله الموسى', imagePath: '/p/photo.jpg' }
const S = (over: Partial<{ surahsAr: string[]; prayer: string; date: string }> = {}) => ({ folder: 'A', surahsAr: ['البقرة'], prayer: 'Isha', date: '2025-03-01', ...over })
describe('thumbnail rule sample job', () => {
  it('builds the same job shape as the pipeline, 1–3 surahs, with the style only when it has knobs', () => {
    const r = buildSampleJob(S({ surahsAr: ['البقرة', 'آل عمران', 'النساء'], prayer: 'Taraweeh' }), rec, { sheikhPrefix: false }, { title: { scale: 0.9 } })
    expect(r.ok).toBe(true); if (r.ok) { expect(r.job.surahsAr).toHaveLength(3); expect(r.job.options.sheikhPrefix).toBe(false); expect(r.job.style).toEqual({ title: { scale: 0.9 } }) }
    const plain = buildSampleJob(S(), rec, { sheikhPrefix: true }, {})
    expect(plain.ok && !('style' in plain.job)).toBe(true)
    expect(buildSampleJob(S({ surahsAr: [] }), rec, { sheikhPrefix: true })).toMatchObject({ ok: false, reason: 'INVALID_JOB' })
    expect(buildSampleJob(S({ surahsAr: ['a', 'b', 'c', 'd'] }), rec, { sheikhPrefix: true })).toMatchObject({ ok: false })
    expect(buildSampleJob(S({ prayer: 'Dhuhr' }), rec, { sheikhPrefix: true })).toMatchObject({ ok: false, reason: 'UNKNOWN_PRAYER' })
    expect(buildSampleJob(S({ date: '01.03.2025' }), rec, { sheikhPrefix: true })).toMatchObject({ ok: false, reason: 'BAD_DATE' })
    expect(buildSampleJob(S(), undefined, { sheikhPrefix: true })).toMatchObject({ ok: false })
  })
  it('exposes the plugin knob table and validates patches by dotted key', () => {
    const schema = styleSchema()
    expect(schema.fields.length).toBeGreaterThan(60)
    expect(schema.fields.find((f) => f.path === 'title.scale')?.field).toMatchObject({ kind: 'number', min: 0.5, max: 1.15, default: 0.9 })
    expect(schema.defaults.title.color).toBe('#D6B33C')
    expect(styleProblems({})).toEqual([])
    expect(styleProblems({ title: { scale: 2 } }).map((e) => e.key)).toEqual(['title.scale'])
    expect(styleProblems({ title: { color: 'gold' }, nope: { x: 1 } }).length).toBe(2)
  })
  it('lists all 114 surahs in order with Latin labels', () => {
    const o = surahOptions()
    expect(o).toHaveLength(114); expect(o[0]!.n).toBe(1); expect(o[1]!.ar).toBe('البقرة'); expect(o[1]!.label.toLowerCase()).toContain('baqara')
    expect(o.every((x) => x.label.length > 0)).toBe(true)
  })
})
