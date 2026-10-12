import { describe, expect, it } from 'vitest'
import { analyseSurah, cleanDateStr, diagnoseStem, parseStem, stripLeadingDescriptor, splitMissingSeparator } from './parse'

const P = 'AbdullahAlMousa'

describe('parseStem', () => {
  it('parses the canonical form', () => {
    expect(parseStem(`${P}IshaAhzab•Munafiqoon-01.03.2025`, P)).toEqual({
      prayer: 'Isha', surahs: ['Ahzab', 'Munafiqoon'], date: '01.03.2025',
    })
  })
  it('normalises 1-digit day/month and is case-insensitive on prayer', () => {
    expect(parseStem(`${P}fajrMulk-5.1.2025`, P)).toEqual({ prayer: 'Fajr', surahs: ['Mulk'], date: '05.01.2025' })
  })
  it('returns null when prefix mismatches', () => {
    expect(parseStem('SomeoneElseIshaMulk-01.01.2025', P)).toBeNull()
  })
})

describe('cleanDateStr', () => {
  it('strips junk characters', () => expect(cleanDateStr('14x.12.2024')).toBe('14.12.2024'))
  it('rejects non-4-digit years', () => expect(cleanDateStr('1.2.25')).toBeNull())
})

describe('surah analysis', () => {
  it('strips ALLCAPS descriptor', () => expect(stripLeadingDescriptor('FINALmuminoon')).toEqual(['FINAL', 'Muminoon']))
  it('strips caps descriptor before Capitalised surah', () => expect(stripLeadingDescriptor('OUTSIDENahl')).toEqual(['OUTSIDE', 'Nahl']))
  it('strips Capitalised descriptor', () => expect(stripLeadingDescriptor('OlayanNisaa')).toEqual(['Olayan', 'Nisaa']))
  it('splits two merged surahs', () => expect(splitMissingSeparator('ShamsLayl')).toEqual(['Shams', 'Layl']))
  it('prefers split over descriptor for SajdahInsan', () => {
    expect(analyseSurah('SajdahInsan').clean).toEqual(['Sajdah', 'Insan'])
  })
  it('drops a trailing section descriptor', () => expect(analyseSurah('GhafirFiroun').clean).toEqual(['Ghafir']))
  it('recognises aliases directly', () => expect(analyseSurah('THashr').issue).toBeNull())
  it('flags unknown surahs', () => expect(analyseSurah('Xyzzy').clean).toBeNull())
})

describe('diagnoseStem', () => {
  it('ready for a good file', () => {
    expect(diagnoseStem(`${P}IshaMulk-01.01.2025`, P).status).toBe('ready')
  })
  it('PREFIX_MISMATCH', () => {
    expect(diagnoseStem('OtherIshaMulk-01.01.2025', P).reason).toBe('PREFIX_MISMATCH')
  })
  it('NO_PRAYER is an error with no suggestion', () => {
    const d = diagnoseStem(`${P}QAF-5.11.2024`, P)
    expect(d.status).toBe('error'); expect(d.reason).toBe('NO_PRAYER'); expect(d.suggestion).toBeNull()
  })
  it('PRAYER_ORDER suggests a reorder', () => {
    const d = diagnoseStem(`${P}AhzabIsha-01.03.2025`, P)
    expect(d.reason).toBe('PRAYER_ORDER'); expect(d.suggestion).toBe(`${P}IshaAhzab-01.03.2025`)
  })
  it('BAD_DATE cleans a dirty date', () => {
    const d = diagnoseStem(`${P}IshaQaf-14x.12.2024`, P)
    expect(d.reason).toBe('BAD_DATE'); expect(d.suggestion).toBe(`${P}IshaQaf-14.12.2024`)
  })
  it('SURAH_FIXABLE builds the corrected stem', () => {
    const d = diagnoseStem(`${P}IshaFINALmuminoon-01.03.2025`, P)
    expect(d.status).toBe('fix'); expect(d.suggestion).toBe(`${P}IshaMuminoon-01.03.2025`)
    const e = diagnoseStem(`${P}FajrSajdahInsan-01.03.2025`, P)
    expect(e.suggestion).toBe(`${P}FajrSajdah•Insan-01.03.2025`)
  })
  it('UNKNOWN_SURAH is an error', () => {
    expect(diagnoseStem(`${P}IshaXyzzy-01.03.2025`, P).reason).toBe('UNKNOWN_SURAH')
  })
})
