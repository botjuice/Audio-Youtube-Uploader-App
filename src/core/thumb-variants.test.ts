import { describe, expect, it } from 'vitest'
import type { PlaylistRule, ThumbnailRule } from '@shared/types'
import { defaultSample, defaultThumbnailRule, newThumbnailRule } from './thumb-rules'
import { reciterVariants, scenarioFor, scenarioTarget } from './thumb-variants'

const R = 'abdullahalmousa'
const rule = (over: Partial<ThumbnailRule>): ThumbnailRule => ({ ...newThumbnailRule([], defaultSample('AbdullahAlMousa')), ...over })
const def = { ...defaultThumbnailRule(), style: { photo: { blur: 1 } } } as ThumbnailRule
const c = (kind: string, value: string, negate = false) => ({ kind, value, negate }) as ThumbnailRule['conditions'][number]

describe('scenarioFor', () => {
  it('builds a situation that satisfies the conditions, and refuses impossible ones', () => {
    expect(scenarioFor([c('prayer', 'Taraweeh'), c('surah', 'Baqarah'), c('keyword', 'Khatm'), c('playlist', 'PL1')], R))
      .toEqual({ prayer: 'Taraweeh', surahsAr: ['البقرة'], keywords: ['Khatm'], include: ['PL1'], exclude: [] })
    expect(scenarioFor([c('reciter', 'Someone Else')], R)).toBeNull()
    expect(scenarioFor([c('reciter', 'Abdullah Al Mousa', true)], R)).toBeNull()
    expect(scenarioFor([c('reciter', 'Abdullah Al Mousa')], R)?.prayer).toBe('Jumuah')
    expect(scenarioFor([c('prayer', 'Isha'), c('prayer', 'Fajr')], R)).toBeNull()
    expect(scenarioFor([c('prayer', 'Isha'), c('prayer', 'Isha', true)], R)).toBeNull()
    expect(scenarioFor([c('surah', 'Kahf', true)], R)?.surahsAr).toEqual(['البقرة'])
    expect(scenarioFor([c('prayer', 'Jumuah', true)], R)?.prayer).toBe('Isha')
    expect(scenarioFor([c('playlist', 'PL1'), c('playlist', 'PL1', true)], R)).toBeNull()
  })
  it('the everyday sample avoids prayers and surahs that other rules name', () => {
    expect(scenarioFor([], R, undefined, { prayers: new Set(['jumuah', 'isha']), surahs: new Set(['الكهف']) })).toMatchObject({ prayer: 'Fajr', surahsAr: ['البقرة'] })
  })
  it('target playlists come from the playlist rules plus the ones the conditions demand', () => {
    const playlistRules = [{ id: 'p', playlistId: 'AUTO', enabled: true, conditions: [{ kind: 'prayer', value: 'Isha', negate: false }] }] as unknown as PlaylistRule[]
    const s = scenarioFor([c('prayer', 'Isha'), c('playlist', 'MANUAL')], R)!
    expect(scenarioTarget(s, R, playlistRules).playlists).toEqual(['AUTO', 'MANUAL'])
    expect(scenarioTarget(scenarioFor([c('prayer', 'Isha'), c('playlist', 'AUTO', true)], R)!, R, playlistRules).playlists).toEqual([])
  })
})

describe('reciterVariants', () => {
  const taraweeh = rule({ id: 't', overlay: true, conditions: [c('prayer', 'Taraweeh')], style: { title: { color: '#f00' } } })
  const mine = rule({ id: 'm', conditions: [c('reciter', 'AbdullahAlMousa')], style: { photo: { blur: 9 } } })
  const theirs = rule({ id: 'o', conditions: [c('reciter', 'Other Guy')], style: { photo: { blur: 5 } } })
  const noop = rule({ id: 'n', conditions: [c('reciter', 'AbdullahAlMousa'), c('prayer', 'Fajr')], style: {} })
  const playlistRule = rule({ id: 'p', overlay: true, conditions: [c('playlist', 'PL1')], style: { title: { color: '#0f0' } } })

  it('lists the everyday look first, then one variant per rule that changes the picture for this reciter', () => {
    const v = reciterVariants({ key: R, folder: 'AbdullahAlMousa' }, [theirs, mine, taraweeh, noop, playlistRule, def], [], undefined, (id) => `Playlist ${id}`, '2025-03-01')
    expect(v.map((x) => x.id)).toEqual(['base', 't', 'p'])
    expect(v[0]).toMatchObject({ title: 'Everyday look', look: 'Reciter is AbdullahAlMousa', when: 'Jumuah · الكهف', sample: { folder: 'AbdullahAlMousa', prayer: 'Jumuah', surahsAr: ['الكهف'], date: '2025-03-01' }, style: { photo: { blur: 9 } } })
    expect(v[1]).toMatchObject({ title: 'Prayer is Taraweeh', look: 'Reciter is AbdullahAlMousa + Prayer is Taraweeh', when: 'Taraweeh · الكهف', style: { photo: { blur: 9 }, title: { color: '#f00' } } })
    expect(v[2]).toMatchObject({ title: 'Playlist is Playlist PL1', when: 'Jumuah · الكهف · in “Playlist PL1”', style: { photo: { blur: 9 }, title: { color: '#0f0' } } })
  })
  it('the everyday sample steps around prayers other rules claim, and disabled rules are ignored', () => {
    const jumuah = rule({ id: 'j', overlay: true, conditions: [c('prayer', 'Jumuah')], style: { title: { color: '#00f' } } })
    const v = reciterVariants({ key: R, folder: 'A' }, [jumuah, { ...taraweeh, enabled: false }, def], [])
    expect(v.map((x) => [x.id, x.sample.prayer])).toEqual([['base', 'Isha'], ['j', 'Jumuah']])
  })
  it('a rule photo is carried on the variant, and an empty rule set gives just the everyday look', () => {
    const photoRule = rule({ id: 'ph', conditions: [c('reciter', 'AbdullahAlMousa')], style: {}, photo: 'ph-1.jpg' })
    expect(reciterVariants({ key: R, folder: 'A' }, [photoRule, def], [])).toMatchObject([{ id: 'base', photo: 'ph-1.jpg' }])
    expect(reciterVariants({ key: R, folder: 'A' }, [], [])).toMatchObject([{ id: 'base', look: 'Plugin defaults' }])
  })
})
