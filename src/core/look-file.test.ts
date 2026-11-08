import { describe, expect, it } from 'vitest'
import { validateStyle } from '../plugins/thumbnail/index'
import { buildLookFile, parseLookFile, pathKnobs, remapStrings, sanitisePatch } from './look-file'

const problems = (p: unknown) => { const v = validateStyle(p ?? {}); return v.ok ? [] : v.errors }

describe('look files', () => {
  it('round-trips a rule through JSON and keeps fonts', () => {
    const f = buildLookFile({ label: ' Ramadan ', overlay: true, style: { title: { color: '#FF0000' } } }, { title: { color: '#FF0000', scale: 0.9 } },
      { appVersion: '3.2.2', styleVersion: 3, now: new Date('2026-11-08T10:00:00Z') }, { '/lib/.yoosyjoosy/fonts/x.ttf': { name: 'x.ttf', data: 'AAAA' } })
    const back = parseLookFile(JSON.stringify(f))
    expect(back).toEqual({ ...f, rule: { label: 'Ramadan', overlay: true, default: false } })
  })
  it('rejects files that are not looks, and newer file versions', () => {
    expect(() => parseLookFile('nope')).toThrow(/not valid JSON/)
    expect(() => parseLookFile('{"format":"other"}')).toThrow(/not a thumbnail look/)
    expect(() => parseLookFile('{"format":"yoosy-joosy.thumbnail-look","version":99}')).toThrow(/newer version/)
    // a minimal older file: knobs only, no look → look falls back to knobs
    expect(parseLookFile('{"format":"yoosy-joosy.thumbnail-look","version":1,"knobs":{"title":{"scale":0.9}}}')).toMatchObject({ knobs: { title: { scale: 0.9 } }, look: { title: { scale: 0.9 } }, rule: { overlay: false, default: false } })
  })
  it('drops only the knobs the plugin rejects and names them', () => {
    const r = sanitisePatch({ title: { color: '#FFFFFF', nope: 3, scale: 99 }, bogus: { x: 1 }, photo: { blur: 2 } } as never, problems)
    expect(r.patch).toEqual({ title: { color: '#FFFFFF' }, photo: { blur: 2 } })
    expect(r.dropped).toEqual(['title.nope (unknown knob)', 'title.scale (must be between 0.5 and 1.15, got 99)', 'bogus (unknown knob)'])
    expect(sanitisePatch({ photo: { blur: 2 } }, problems)).toEqual({ patch: { photo: { blur: 2 } }, dropped: [] })
  })
  it('finds and remaps font paths', () => {
    const p = { reciter: { font: '/old/fonts/a.ttf', scale: 1 }, meta: { font: 'tajawal' } } as never
    expect(pathKnobs(p)).toEqual([{ path: 'reciter.font', value: '/old/fonts/a.ttf' }])
    expect(remapStrings(p, { '/old/fonts/a.ttf': '/new/fonts/a-1.ttf' })).toEqual({ reciter: { font: '/new/fonts/a-1.ttf', scale: 1 }, meta: { font: 'tajawal' } })
  })
})
