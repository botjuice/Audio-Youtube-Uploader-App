import { describe, expect, it } from 'vitest'
import type { PlaylistRule } from '@shared/types'
import { resolvePlaylists } from './rules'

const rules: PlaylistRule[] = [
  { id: '1', match: 'reciter', value: 'Abdullah Al Mousa', playlistId: 'PL_R', enabled: true },
  { id: '2', match: 'prayer', value: 'isha', playlistId: 'PL_ISHA', enabled: true },
  { id: '3', match: 'surah', value: 'al-baqarah', playlistId: 'PL_BAQ', enabled: true },
  { id: '4', match: 'keyword', value: 'taraweeh', playlistId: 'PL_TARA', enabled: true },
  { id: '5', match: 'prayer', value: 'fajr', playlistId: 'PL_OFF', enabled: false },
  { id: '6', match: 'surah', value: 'Baqarah', playlistId: 'PL_BAQ', enabled: true }, // duplicate target
]

const t = {
  reciterFolder: 'AbdullahAlMousa',
  stem: 'AbdullahAlMousaIshaBaqarah-01.03.2025',
  parsed: { prayer: 'Isha', surahs: ['Baqarah'], date: '01.03.2025' },
}

describe('resolvePlaylists', () => {
  it('matches reciter (space-insensitive), prayer, surah (alias-insensitive); dedupes; ignores disabled', () => {
    expect(resolvePlaylists(t, rules).auto).toEqual(['PL_R', 'PL_ISHA', 'PL_BAQ'])
  })
  it('keyword rule matches substring of stem', () => {
    const k = { ...t, stem: 'AbdullahAlMousaTaraweehMulk-01.03.2025', parsed: { prayer: 'Taraweeh', surahs: ['Mulk'], date: '01.03.2025' } }
    expect(resolvePlaylists(k, rules).auto).toContain('PL_TARA')
  })
  it('applies per-recording include/exclude overrides', () => {
    const r = resolvePlaylists(t, rules, { include: ['PL_EXTRA'], exclude: ['PL_ISHA'] })
    expect(r.auto).toEqual(['PL_R', 'PL_ISHA', 'PL_BAQ'])
    expect(r.final).toEqual(['PL_R', 'PL_BAQ', 'PL_EXTRA'])
  })
})
