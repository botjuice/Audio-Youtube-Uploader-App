import { describe, expect, it } from 'vitest'
import type { PlaylistRule } from '@shared/types'
import { describeRule, resolvePlaylists, validateRule } from './rules'

const R = (id: string, playlistId: string, conditions: PlaylistRule['conditions']): PlaylistRule => ({ id, playlistId, conditions, enabled: true })
const main = R('main', 'PL_MAIN', [{ kind: 'reciter', value: 'Abdullah Al Mousa', negate: false }, { kind: 'prayer', value: 'Taraweeh', negate: true }])
const tara = R('tara', 'PL_TARA', [{ kind: 'reciter', value: 'Abdullah Al Mousa', negate: false }, { kind: 'prayer', value: 'taraweeh', negate: false }])
const kw   = R('kw', 'PL_FINAL', [{ kind: 'keyword', value: 'final', negate: false }])
const baq  = R('baq', 'PL_BAQ', [{ kind: 'surah', value: 'al-baqarah', negate: false }, { kind: 'keyword', value: 'final', negate: true }])
const rules = [main, tara, kw, baq]
const rec = (prayer: string, surahs: string[], keywords: string[] = []) => ({ reciter: 'abdullahalmousa', tokens: { prayer, surahs, keywords } })

describe('AND / NOT rules', () => {
  it('Taraweeh recording → Taraweeh playlist only; Isha recording → main only', () => {
    expect(resolvePlaylists(rec('Taraweeh', ['Mulk']), rules).auto).toEqual(['PL_TARA'])
    expect(resolvePlaylists(rec('Isha', ['Mulk']), rules).auto).toEqual(['PL_MAIN'])
  })
  it('keyword conditions, including "is not" on list fields', () => {
    expect(resolvePlaylists(rec('Isha', ['Baqarah'], ['final']), rules).auto).toEqual(['PL_MAIN', 'PL_FINAL'])   // baq excluded by "keyword is not final"
    expect(resolvePlaylists(rec('Isha', ['Baqarah']), rules).auto).toEqual(['PL_MAIN', 'PL_BAQ'])
  })
  it('reports which rules fired, and applies overrides', () => {
    const r = resolvePlaylists(rec('Isha', ['Baqarah']), rules, undefined, { include: ['PL_X'], exclude: ['PL_BAQ'] })
    expect(r.via).toEqual({ PL_MAIN: ['main'], PL_BAQ: ['baq'] })
    expect(r.final).toEqual(['PL_MAIN', 'PL_X'])
  })
  it('other reciter never matches reciter-scoped rules', () => {
    expect(resolvePlaylists({ reciter: 'mishary', tokens: { prayer: 'Isha', surahs: ['Mulk'], keywords: [] } }, rules).auto).toEqual([])
  })
})

describe('validateRule', () => {
  const c = (kind: PlaylistRule['conditions'][0]['kind'], value: string, negate = false) => ({ kind, value, negate })
  it('refuses purely negative, empty, contradictory and impossible rules', () => {
    expect(validateRule({ playlistId: 'p', conditions: [c('prayer', 'Taraweeh', true)] })[0]).toMatch(/is not/)
    expect(validateRule({ playlistId: 'p', conditions: [] })[0]).toMatch(/at least one/i)
    expect(validateRule({ playlistId: '', conditions: [c('prayer', 'Isha')] })[0]).toMatch(/playlist/)
    expect(validateRule({ playlistId: 'p', conditions: [c('prayer', 'Isha'), c('prayer', 'Isha', true)] }).join()).toMatch(/contradict/)
    expect(validateRule({ playlistId: 'p', conditions: [c('prayer', 'Isha'), c('prayer', 'Fajr')] }).join()).toMatch(/only one prayer/)
    expect(validateRule({ playlistId: 'p', conditions: [c('reciter', 'A'), c('prayer', 'Isha'), c('surah', 'Mulk'), c('keyword', 'x')] }).join()).toMatch(/At most 3/)
    expect(validateRule({ playlistId: 'p', conditions: [c('prayer', 'Dhuhr')] }).join()).toMatch(/Unknown prayer/)
    expect(validateRule({ playlistId: 'p', conditions: [c('surah', 'Xyzzy')] }).join()).toMatch(/not a known surah/)
  })
  it('accepts the two example rules and surah+surah (list field)', () => {
    expect(validateRule(main)).toEqual([]); expect(validateRule(tara)).toEqual([])
    expect(validateRule({ playlistId: 'p', conditions: [c('surah', 'Baqarah'), c('surah', 'Imran')] })).toEqual([])
  })
})

describe('describeRule', () => {
  it('auto-describes, custom label wins', () => {
    expect(describeRule(main)).toBe('Reciter is Abdullah Al Mousa · Prayer is not Taraweeh')
    expect(describeRule({ ...main, label: 'Main playlist' })).toBe('Main playlist')
  })
})
