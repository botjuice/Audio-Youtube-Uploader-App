import { describe, expect, it } from 'vitest'
import type { KeywordDef, PlaylistRule } from '@shared/types'
import { resolvePlaylists } from './rules'

const rules: PlaylistRule[] = [
  { id: '1', match: 'reciter', value: 'Abdullah Al Mousa', playlistId: 'PL_R', enabled: true },
  { id: '2', match: 'prayer', value: 'isha', playlistId: 'PL_ISHA', enabled: true },
  { id: '3', match: 'surah', value: 'al-baqarah', playlistId: 'PL_BAQ', enabled: true },
  { id: '5', match: 'prayer', value: 'fajr', playlistId: 'PL_OFF', enabled: false },
  { id: '6', match: 'surah', value: 'Baqarah', playlistId: 'PL_BAQ', enabled: true }, // duplicate target
]
const keywords: KeywordDef[] = [
  { name: 'final', playlistIds: ['PL_FINAL', 'PL_ALL'] },
  { name: 'outside', playlistIds: ['PL_OUT', 'PL_ALL'] },
]
const t = { reciter: 'abdullahalmousa', tokens: { prayer: 'Isha', surahs: ['Baqarah'], keywords: ['final', 'outside'] } }

describe('resolvePlaylists', () => {
  it('rules ∪ every keyword, deduped, disabled ignored', () => {
    expect(resolvePlaylists(t, rules, keywords).auto).toEqual(['PL_R', 'PL_ISHA', 'PL_BAQ', 'PL_FINAL', 'PL_ALL', 'PL_OUT'])
  })
  it('applies per-recording include/exclude overrides', () => {
    const r = resolvePlaylists(t, rules, keywords, { include: ['PL_EXTRA'], exclude: ['PL_ISHA', 'PL_ALL'] })
    expect(r.final).toEqual(['PL_R', 'PL_BAQ', 'PL_FINAL', 'PL_OUT', 'PL_EXTRA'])
  })
  it('no reciter → reciter rules do not fire', () => {
    expect(resolvePlaylists({ ...t, reciter: null }, rules, keywords).auto).not.toContain('PL_R')
  })
})
