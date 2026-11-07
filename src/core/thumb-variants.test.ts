import { describe, expect, it } from 'vitest'
import type { PlaylistRule, ThumbnailRule } from '@shared/types'
import { defaultSample, defaultThumbnailRule, newThumbnailRule } from './thumb-rules'
import { enumerateLooks, looksForOverlay, looksForReciter, overlayPreview, situationDomain, situations } from './thumb-variants'

const abdullah = { key: 'abdullahalmousa', folder: 'AbdullahAlMousa' }
const mishary = { key: 'mishary', folder: 'Mishary' }
const c = (kind: string, value: string, negate = false) => ({ kind, value, negate }) as ThumbnailRule['conditions'][number]
const rule = (id: string, conditions: ThumbnailRule['conditions'], style: ThumbnailRule['style'], over: Partial<ThumbnailRule> = {}): ThumbnailRule =>
  ({ ...newThumbnailRule(conditions, defaultSample('AbdullahAlMousa')), id, style, ...over })
const def = { ...defaultThumbnailRule(), style: { photo: { blur: 1 } } } as ThumbnailRule

describe('situation domain', () => {
  it('collects the values conditions name (thumbnail and playlist rules) and puts a neutral value first', () => {
    const rules = [rule('a', [c('prayer', 'isha'), c('surah', 'Baqarah'), c('keyword', 'Khatm')], {})]
    const pl = [{ id: 'p', playlistId: 'PL', enabled: true, conditions: [{ kind: 'prayer', value: 'Taraweeh', negate: false }] }] as unknown as PlaylistRule[]
    expect(situationDomain(rules, pl)).toEqual({ prayers: ['Jumuah', 'Isha', 'Taraweeh'], surahs: ['الكهف', 'البقرة'], keywords: ['Khatm'] })
    expect(situationDomain([rule('j', [c('prayer', 'Jumuah'), c('surah', 'Kahf')], {})], []).prayers[0]).toBe('Isha')
    expect(situationDomain([rule('j', [c('prayer', 'Jumuah'), c('surah', 'Kahf')], {})], []).surahs[0]).toBe('البقرة')
  })
  it('enumerates simplest-first: no keywords, one neutral surah, neutral prayer', () => {
    const s = situations({ prayers: ['Jumuah', 'Isha'], surahs: ['الكهف', 'البقرة'], keywords: ['K'] })
    expect(s[0]).toEqual({ prayer: 'Jumuah', surahsAr: ['الكهف'], keywords: [] })
    expect(s.length).toBe(2 * 3 * 2)   // 2 keyword sets × (2 singles + 1 pair) × 2 prayers
  })
})

describe('enumerateLooks', () => {
  // Umo's example: B = Surah is Baqarah, I = Prayer is Isha, AI = Abdullah + Isha
  const B = rule('B', [c('surah', 'Baqarah')], { title: { color: '#111' } }, { overlay: true })
  const I = rule('I', [c('prayer', 'Isha')], { title: { color: '#222' } }, { overlay: true })
  const AI = rule('AI', [c('reciter', 'AbdullahAlMousa'), c('prayer', 'Isha')], { title: { color: '#333' } }, { overlay: true })
  const rules = [B, I, AI, def]

  it('lists only final looks: the in-between "Abdullah + B + I without AI" never appears', () => {
    const all = enumerateLooks([abdullah, mishary], rules, [], undefined, undefined, '2025-03-01')
    const chains = (folder: string) => all.filter((v) => v.reciter === folder).map((v) => v.overlayIds.join('+'))
    expect(chains('AbdullahAlMousa')).toEqual(['', 'I+AI', 'B', 'B+I+AI'])
    expect(chains('Mishary')).toEqual(['', 'I', 'B', 'B+I'])
    expect(looksForOverlay(all, 'B').map((v) => `${v.reciter}: ${v.overlayIds.join('+')} (${v.when})`)).toEqual([
      'AbdullahAlMousa: B (Jumuah · البقرة)', 'AbdullahAlMousa: B+I+AI (Isha · البقرة)', 'Mishary: B (Jumuah · البقرة)', 'Mishary: B+I (Isha · البقرة)',
    ])
    const v = looksForOverlay(all, 'B')[1]!
    expect(v).toMatchObject({ baseId: 'default', look: 'Default look + Surah is Baqarah + Prayer is Isha + Reciter is AbdullahAlMousa · Prayer is Isha', sample: { folder: 'AbdullahAlMousa', prayer: 'Isha', surahsAr: ['البقرة'], date: '2025-03-01' }, style: { photo: { blur: 1 }, title: { color: '#333' } } })
  })
  it('the first look per reciter is the everyday one, and identical pictures are merged on the reciter page', () => {
    const quiet = rule('q', [c('reciter', 'Mishary')], {}, { overlay: true })   // no knobs → same picture as without it
    const all = enumerateLooks([mishary], [quiet, I, def], [])
    expect(all.map((v) => v.overlayIds.join('+'))).toEqual(['q', 'q+I'])
    const r = looksForReciter(all, 'Mishary')
    expect(r[0]?.when).toBe('Jumuah · الكهف')
    expect(r.map((v) => v.style?.title?.color ?? null)).toEqual([null, '#222'])
  })
  it('playlist conditions are reachable only through the playlist rules', () => {
    const P = rule('P', [c('playlist', 'PL1')], { title: { color: '#444' } }, { overlay: true })
    const grant = [{ id: 'g', playlistId: 'PL1', enabled: true, conditions: [{ kind: 'reciter', value: 'Mishary', negate: false }, { kind: 'prayer', value: 'Fajr', negate: false }] }] as unknown as PlaylistRule[]
    const all = enumerateLooks([abdullah, mishary], [P, def], grant, undefined, (id) => `Playlist ${id}`)
    expect(looksForOverlay(all, 'P').map((v) => `${v.reciter}: ${v.when}`)).toEqual(['Mishary: Fajr · الكهف · in “Playlist PL1”'])
    expect(looksForOverlay(enumerateLooks([abdullah, mishary], [P, def], []), 'P')).toEqual([])
  })
  it('a base rule with its own photo carries it, and a sample keyword reaches keyword overlays', () => {
    const base = rule('base', [c('reciter', 'AbdullahAlMousa')], {}, { photo: 'ph.jpg' })
    const K = rule('K', [c('keyword', 'Khatm')], { title: { color: '#555' } }, { overlay: true })
    const all = enumerateLooks([abdullah], [base, K, def], [])
    expect(looksForOverlay(all, 'K')[0]).toMatchObject({ baseId: 'base', photo: 'ph.jpg', when: 'Jumuah · الكهف · keyword “Khatm”', sample: { keywords: ['Khatm'] } })
  })
})

describe('overlayPreview', () => {
  const I = rule('I', [c('prayer', 'Isha')], { title: { color: '#222' } }, { overlay: true })
  const rules = [I, def]
  const all = enumerateLooks([abdullah, mishary], rules, [])
  it('shows the option the saved sample lands on, or the first one when the sample does not trigger the overlay', () => {
    const fits = overlayPreview(all, { id: 'I', sample: { folder: 'Mishary', surahsAr: ['يس'], prayer: 'Isha', date: '2025-01-01' } }, [abdullah, mishary], rules, [])
    expect(fits).toMatchObject({ sampleFits: true, current: { reciter: 'Mishary', overlayIds: ['I'] } })
    expect(fits.options.map((v) => v.reciter)).toEqual(['AbdullahAlMousa', 'Mishary'])
    const miss = overlayPreview(all, { id: 'I', sample: { folder: 'Mishary', surahsAr: ['يس'], prayer: 'Fajr', date: '2025-01-01' } }, [abdullah, mishary], rules, [])
    expect(miss).toMatchObject({ sampleFits: false, current: { reciter: 'AbdullahAlMousa' } })
    const gone = overlayPreview(all, { id: 'I', sample: { folder: 'Nobody', surahsAr: ['يس'], prayer: 'Isha', date: '2025-01-01' } }, [abdullah, mishary], rules, [])
    expect(gone.sampleFits).toBe(false)
  })
  it('a sample that gives the same picture without triggering the overlay does not count as fitting', () => {
    // B's only knob is overridden by AI, so "Isha + Kahf" (I + AI) paints exactly like "Isha + Baqarah" (B + I + AI) — but B is not part of it.
    const B = rule('B', [c('surah', 'Baqarah')], { title: { color: '#111' } }, { overlay: true })
    const AI = rule('AI', [c('reciter', 'AbdullahAlMousa'), c('prayer', 'Isha')], { title: { color: '#333' } }, { overlay: true })
    const rs = [B, I, AI, def]
    const all2 = enumerateLooks([abdullah], rs, [])
    const r = overlayPreview(all2, { id: 'B', sample: { folder: 'AbdullahAlMousa', surahsAr: ['الكهف'], prayer: 'Isha', date: '2025-01-01' } }, [abdullah], rs, [])
    expect(r.sampleFits).toBe(false)
    expect(r.current?.when).toBe('Jumuah · البقرة')
  })
})
