import { describe, expect, it } from 'vitest'
import type { ThumbnailRule } from '@shared/types'
import { countKnobs, defaultThumbnailRule, describeLook, describeThumbRule, effectiveStyle, mergePatches, normaliseThumbRules, prunePatch, resolveThumbnailLook, resolveThumbnailRule, resolveThumbnailStyle, setKnob, validateThumbRule } from './thumb-rules'

const sample = { folder: 'AbdullahAlMousa', surahsAr: ['الفاتحة'], prayer: 'Isha', date: '2026-01-01' }
const R = (id: string, conditions: ThumbnailRule['conditions'], style: ThumbnailRule['style'] = { title: { color: '#ff0000' } }): ThumbnailRule => ({ id, enabled: true, conditions, style, sample })
const tara = R('tara', [{ kind: 'prayer', value: 'Taraweeh', negate: false }], { overlay: { bottom: 1 } })
const mousa = R('mousa', [{ kind: 'reciter', value: 'Abdullah Al Mousa', negate: false }])
const pl = R('pl', [{ kind: 'playlist', value: 'PL_X', negate: false }, { kind: 'surah', value: 'baqarah', negate: true }], { frame: { width: 6 } })
const def = { ...defaultThumbnailRule(), style: { photo: { blur: 2 } } }
const target = (prayer: string, playlists: string[] = [], surahs: string[] = ['Mulk']) => ({ reciter: 'abdullahalmousa', tokens: { prayer, surahs, keywords: [] }, playlists })

describe('thumbnail rule resolution', () => {
  it('first enabled match in list order wins', () => {
    expect(resolveThumbnailRule(target('Taraweeh'), [tara, mousa, def])?.id).toBe('tara')
    expect(resolveThumbnailRule(target('Taraweeh'), [mousa, tara, def])?.id).toBe('mousa')
    expect(resolveThumbnailRule(target('Taraweeh'), [{ ...mousa, enabled: false }, tara, def])?.id).toBe('tara')
  })
  it('falls back to the default rule, wherever it sits in the list', () => {
    expect(resolveThumbnailRule({ ...target('Isha'), reciter: 'other' }, [def, tara, mousa])?.id).toBe('default')
    expect(resolveThumbnailRule({ ...target('Isha'), reciter: 'other' }, [tara])).toBeNull()
  })
  it('playlist conditions see the resolved playlists, combined with surah "is not"', () => {
    expect(resolveThumbnailRule(target('Isha', ['PL_X']), [pl, def])?.id).toBe('pl')
    expect(resolveThumbnailRule(target('Isha', ['PL_X'], ['Baqarah']), [pl, def])?.id).toBe('default')
    expect(resolveThumbnailRule(target('Isha', []), [pl, def])?.id).toBe('default')
  })
  it('an empty style on the winning rule means "plugin defaults"', () => {
    expect(resolveThumbnailStyle(target('Taraweeh'), [tara]).style).toEqual({ overlay: { bottom: 1 } })
    expect(resolveThumbnailStyle(target('Isha'), [defaultThumbnailRule()]).style).toBeUndefined()
    expect(resolveThumbnailStyle(target('Isha'), [def]).style).toEqual({ photo: { blur: 2 } })
  })
  it('every rule inherits the Default look; its own changes win per knob', () => {
    const d = { ...defaultThumbnailRule(), style: { photo: { blur: 2 }, title: { color: '#111111', scale: 0.9 } } }
    expect(resolveThumbnailLook(target('Taraweeh'), [tara, d]).style).toEqual({ photo: { blur: 2 }, title: { color: '#111111', scale: 0.9 }, overlay: { bottom: 1 } })
    expect(resolveThumbnailLook(target('Isha'), [mousa, d]).style).toEqual({ photo: { blur: 2 }, title: { color: '#ff0000', scale: 0.9 } })
    expect(resolveThumbnailLook(target('Isha'), [R('empty', mousa.conditions, {}), d]).style).toEqual(d.style)
    expect(effectiveStyle(mousa, [mousa, d])).toEqual({ photo: { blur: 2 }, title: { color: '#ff0000', scale: 0.9 } })
    expect(effectiveStyle(d, [mousa, d])).toEqual(d.style)
  })
})

describe('overlay rules', () => {
  const taraOverlay: ThumbnailRule = { ...R('tara-ov', [{ kind: 'prayer', value: 'Taraweeh', negate: false }], { title: { color: '#00FF00' }, frame: { width: 8 } }), overlay: true, label: 'Taraweeh gold' }
  const second: ThumbnailRule = { ...R('ov2', [{ kind: 'reciter', value: 'Abdullah Al Mousa', negate: false }], { frame: { width: 2, radius: 10 } }), overlay: true }
  it('overlays never win the base, they layer on top of whichever rule did (or the default)', () => {
    const rules = [taraOverlay, mousa, def]
    const look = resolveThumbnailLook(target('Taraweeh'), rules)
    expect(look.base?.id).toBe('mousa'); expect(look.overlays.map((r) => r.id)).toEqual(['tara-ov'])
    expect(look.style).toEqual({ photo: { blur: 2 }, title: { color: '#00FF00' }, frame: { width: 8 } })   // default look under mousa, mousa's title.color replaced by the overlay
    const noBase = resolveThumbnailLook({ ...target('Taraweeh'), reciter: 'other' }, rules)
    expect(noBase.base?.id).toBe('default'); expect(noBase.style).toEqual({ photo: { blur: 2 }, title: { color: '#00FF00' }, frame: { width: 8 } })
    expect(resolveThumbnailLook(target('Isha'), rules).style).toEqual({ photo: { blur: 2 }, title: { color: '#ff0000' } })   // overlay didn't match
  })
  it('several overlays apply in list order, later wins per knob; groups merge', () => {
    const look = resolveThumbnailLook(target('Taraweeh'), [taraOverlay, second, def])
    expect(look.overlays.map((r) => r.id)).toEqual(['tara-ov', 'ov2'])
    expect(look.style).toEqual({ photo: { blur: 2 }, title: { color: '#00FF00' }, frame: { width: 2, radius: 10 } })
    expect(resolveThumbnailLook(target('Taraweeh'), [second, taraOverlay, def]).style?.frame).toEqual({ width: 8, radius: 10 })
    expect(mergePatches({ a: { x: 1, y: 2 } } as never, { a: { y: 3 }, b: { z: 1 } } as never)).toEqual({ a: { x: 1, y: 3 }, b: { z: 1 } })
  })
  it("the base rule's photo is used; overlays never carry one", () => {
    const photoBase = { ...mousa, photo: 'mousa-1.jpg' }
    expect(resolveThumbnailLook(target('Taraweeh'), [{ ...taraOverlay, photo: 'ignored.jpg' }, photoBase, def]).photo).toBe('mousa-1.jpg')
    expect(resolveThumbnailLook(target('Isha'), [photoBase, def]).photo).toBe('mousa-1.jpg')
    expect(resolveThumbnailLook({ ...target('Isha'), reciter: 'other' }, [photoBase, def]).photo).toBeUndefined()
    expect(normaliseThumbRules([{ ...taraOverlay, photo: 'x.jpg' }])[0]!.photo).toBeUndefined()
    expect(normaliseThumbRules([{ ...def, photo: 'x.jpg' }])[0]!.photo).toBeUndefined()
    expect(resolveThumbnailLook({ ...target('Isha'), reciter: 'other' }, [{ ...def, photo: 'x.jpg' }]).photo).toBeUndefined()
  })
  it('describes the combined look and refuses an overlay default', () => {
    expect(describeLook(resolveThumbnailLook(target('Taraweeh'), [taraOverlay, mousa, def]))).toBe('Reciter is Abdullah Al Mousa + Taraweeh gold')
    expect(describeLook({ base: null, overlays: [] })).toBeNull()
    expect(validateThumbRule({ ...def, overlay: true })[0]).toMatch(/cannot be an overlay/)
    expect(normaliseThumbRules([{ ...def, overlay: true }])[0]!.overlay).toBe(false)
  })
})

describe('thumbnail rule validation', () => {
  it('needs a condition unless it is the default; the default may not have any', () => {
    expect(validateThumbRule(R('x', []))).toContain('Add at least one condition')
    expect(validateThumbRule(def)).toEqual([])
    expect(validateThumbRule({ ...def, conditions: tara.conditions })[0]).toMatch(/default look has no conditions/)
  })
  it('refuses purely negative, contradictory and empty conditions', () => {
    expect(validateThumbRule(R('x', [{ kind: 'playlist', value: 'PL_X', negate: true }]))[0]).toMatch(/must be “is”/)
    expect(validateThumbRule(R('x', [{ kind: 'playlist', value: 'PL_X', negate: false }, { kind: 'playlist', value: 'PL_X', negate: true }]))[0]).toMatch(/contradict/)
    expect(validateThumbRule(R('x', [{ kind: 'playlist', value: '', negate: false }]))[0]).toMatch(/needs a value/)
    expect(validateThumbRule(R('x', [{ kind: 'playlist', value: 'A', negate: false }, { kind: 'playlist', value: 'B', negate: false }]))).toEqual([])  // a recording can be in two playlists
  })
  it('checks the preview sample', () => {
    expect(validateThumbRule({ ...mousa, sample: { ...sample, surahsAr: [] } })[0]).toMatch(/1–3 surahs/)
    expect(validateThumbRule({ ...mousa, sample: { ...sample, date: '1.1.2026' } })[0]).toMatch(/real date/)
  })
})

describe('describe / normalise / patch helpers', () => {
  it('describes rules with playlist titles and the default', () => {
    expect(describeThumbRule(pl, (id) => ({ PL_X: 'Taraweeh 2025' })[id] ?? id)).toBe('Playlist is Taraweeh 2025 · Surah is not baqarah')
    expect(describeThumbRule(def)).toBe('Default look')
    expect(describeThumbRule({ ...def, label: 'Gold' })).toBe('Gold')
  })
  it('keeps exactly one default rule, last, without conditions', () => {
    const n = normaliseThumbRules([tara, { ...def, conditions: tara.conditions }, mousa])
    expect(n.map((r) => r.id)).toEqual(['tara', 'mousa', 'default'])
    expect(n[2]!.conditions).toEqual([]); expect(n[2]!.style).toEqual({ photo: { blur: 2 } })
    expect(normaliseThumbRules([]).map((r) => r.id)).toEqual(['default'])
  })
  it('prunes knobs equal to their default and counts the rest', () => {
    const defaults = { title: { color: '#D6B33C', scale: 1 }, reciter: { pill: { opacity: 0, radius: 16 } } }
    expect(prunePatch({ title: { color: '#D6B33C', scale: 0.9 }, reciter: { pill: { opacity: 0 } } }, defaults)).toEqual({ title: { scale: 0.9 } })
    expect(countKnobs({ title: { scale: 0.9 }, reciter: { pill: { opacity: 0.5, radius: 2 } } })).toBe(3)
    expect(setKnob({ title: { scale: 0.9 } }, 'reciter.pill.opacity', 0.5)).toEqual({ title: { scale: 0.9 }, reciter: { pill: { opacity: 0.5 } } })
    expect(setKnob({ title: { scale: 0.9, color: '#fff' } }, 'title.scale', undefined)).toEqual({ title: { color: '#fff' } })
  })
})
