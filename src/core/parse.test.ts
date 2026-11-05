import { existsSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildVocabulary, cleanDateStr, diagnoseStem, tokenize } from './parse'

const V = buildVocabulary([{ folder: 'Abdullah Al Mousa', aliases: ['Mousa'] }, { folder: 'Mishary' }], undefined, ['final', 'outside'])
const P = 'AbdullahAlMousa'

describe('tokenize', () => {
  it('parses the canonical glued form, in any order, with optional separators', () => {
    for (const s of [`${P}IshaAhzab•Munafiqoon-01.03.2025`, `Isha-Ahzab-Munafiqoon-01.03.2025-${P}`, `01.03.2025 Isha Ahzab Munafiqoon`, `IshaAhzabMunafiqoon-1.3.2025`]) {
      const d = diagnoseStem(s, V)
      expect(d.status, s).toBe('ready')
      expect(d.parsed!.prayer).toBe('Isha'); expect(d.parsed!.surahs.map((x) => x.toLowerCase())).toEqual(['ahzab', 'munafiqoon']); expect(d.parsed!.date).toBe('01.03.2025')
    }
  })
  it('identifies the reciter from the folder key or an alias, else null', () => {
    expect(tokenize(`${P}IshaMulk-01.03.2025`, V).reciter).toBe('abdullahalmousa')
    expect(tokenize(`MousaIshaMulk-01.03.2025`, V).reciter).toBe('abdullahalmousa')
    expect(tokenize(`MisharyFajrMulk-01.03.2025`, V).reciter).toBe('mishary')
    expect(tokenize(`IshaMulk-01.03.2025`, V).reciter).toBeNull()
  })
  it('a second prayer-looking word becomes a surah (IshaJumuah = Surah Al-Jumuah at Isha)', () => {
    const t = tokenize(`${P}IshaJumuah-01.03.2025`, V)
    expect(t.prayer).toBe('Isha'); expect(t.surahs.map((s) => s.toLowerCase())).toEqual(['jumuah'])
  })
  it('longest match: a reciter whose name contains a surah is still the reciter', () => {
    const v = buildVocabulary([{ folder: 'Yaseen Khan' }])
    const t = tokenize('YaseenKhanFajrYaseen-01.01.2025', v)
    expect(t.reciter).toBe('yaseenkhan'); expect(t.surahs.map((s) => s.toLowerCase())).toEqual(['yaseen'])
  })
  it('collects several keywords and routes them all', () => {
    const t = tokenize(`${P}IshaMulk-01.03.2025 #final #outside`, V)
    expect(t.keywords).toEqual(['final', 'outside']); expect(t.leftovers).toEqual([])
  })
  it('cleans dirty dates and flags them', () => {
    const t = tokenize(`${P}IshaQaf-14x.12.2024`, V)
    expect(t.date).toBe('14.12.2024'); expect(t.dateDirty).toBe(true)
    expect(cleanDateStr('1.2.25')).toBeNull()
  })
})

describe('leftovers and fixes', () => {
  it('glued descriptor before a surah is a leftover; fix removes just that', () => {
    const d = diagnoseStem(`${P}IshaOlayanNisaa-28.10.2024`, V)
    expect(d.status).toBe('error'); expect(d.reason).toBe('LEFTOVER'); expect(d.tokens.leftovers).toEqual(['Olayan'])
    expect(d.fixable).toBe(true); expect(d.suggestion).toBe(`${P}IshaNisaa-28.10.2024`)
  })
  it('ALLCAPS descriptor before a surah', () => {
    const d = diagnoseStem(`${P}TahajjudOUTSIDENahl-23.03.2025`, buildVocabulary([{ folder: P }]))
    expect(d.tokens.leftovers).toEqual(['OUTSIDE']); expect(d.suggestion).toBe(`${P}TahajjudNahl-23.03.2025`)
  })
  it('…but a registered keyword is recognised instead', () => {
    const d = diagnoseStem(`${P}TahajjudOUTSIDENahl-23.03.2025`, V)
    expect(d.status).toBe('ready'); expect(d.parsed!.keywords).toEqual(['outside'])
  })
  it('separated leftovers are removed cleanly (no stray separators)', () => {
    expect(diagnoseStem(`${P}IshaMulk-Olayan-01.03.2025`, V).suggestion).toBe(`${P}IshaMulk-01.03.2025`)
    expect(diagnoseStem(`${P}IshaMulk#Olayan-01.03.2025`, V).suggestion).toBe(`${P}IshaMulk-01.03.2025`)
  })
  it('trailing descriptor after a surah', () => {
    const d = diagnoseStem(`${P}IshaGhafirFiroun-05.12.2024`, V)
    expect(d.tokens.surahs.map((s) => s.toLowerCase())).toEqual(['ghafir']); expect(d.tokens.leftovers).toEqual(['Firoun'])
  })
  it('two surahs without • split by longest match — no fix needed', () => {
    expect(diagnoseStem(`${P}IshaShamsLayl-06.10.2024`, V).status).toBe('ready')
    expect(diagnoseStem(`${P}FajrSajdahInsan-07.02.2025`, V).parsed!.surahs.map((s) => s.toLowerCase())).toEqual(['sajdah', 'insan'])
  })
  it('missing prayer is not fixable even when there are leftovers', () => {
    const d = diagnoseStem(`${P}Qaf2nd-14x.12.2024`, V)
    expect(d.reason).toBe('NO_PRAYER'); expect(d.fixable).toBe(false); expect(d.tokens.leftovers).toEqual(['2nd'])
  })
  it('no date / no surah', () => {
    expect(diagnoseStem('Fatiha', V).reason).toBe('NO_DATE')
    expect(diagnoseStem(`${P}Isha-01.03.2025`, V).reason).toBe('NO_SURAH')
  })
})

const LIB = '/Users/umo/Projects/Yoosy Joosy/AbdullahAlMousa'
describe.skipIf(!existsSync(LIB))('real library (local only)', () => {
  it('classifies every real file as expected', () => {
    const v = buildVocabulary([{ folder: 'AbdullahAlMousa' }])
    const stems = readdirSync(LIB).filter((f) => f.endsWith('.m4a')).map((f) => f.slice(0, -4))
    const by = Object.fromEntries(stems.map((s) => [s, diagnoseStem(s, v)]))
    const ready = stems.filter((s) => by[s]!.status === 'ready')
    expect(ready.length).toBe(42)   // 40 previously ready + ShamsLayl + SajdahInsan
    const fixable = stems.filter((s) => by[s]!.fixable).sort()
    expect(fixable).toEqual([
      'AbdullahAlMousaIshaFINALmuminoon-09.04.2025', 'AbdullahAlMousaIshaGhafirFiroun-05.12.2024',
      'AbdullahAlMousaIshaOlayanNisaa-28.10.2024', 'AbdullahAlMousaTahajjudOUTSIDENahl-23.03.2025',
    ])
    expect(by['AbdullahAlMousaIshaAmnArsool-22.03.2025']!.tokens.leftovers.length).toBeGreaterThan(0)
    for (const s of ['AbdullahAlMousaQAF-5.11.2024', 'AbdullahAlMousaQaf2nd-14x.12.2024', 'AbdullahAlMousaSaad-26.11.2024']) expect(by[s]!.reason, s).toBe('NO_PRAYER')
    expect(by['Fatiha']!.reason).toBe('NO_DATE')
    for (const s of ready) expect(by[s]!.parsed!.reciter, s).toBe('abdullahalmousa')
  })
})
