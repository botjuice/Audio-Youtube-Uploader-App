/**
 * Every distinct thumbnail look a reciter's videos can get.
 *
 * For each enabled rule whose conditions a recording of this reciter could satisfy, build one concrete
 * situation (prayer, surahs, keywords, playlists) in which they all hold, resolve the full look for it,
 * and keep the ones that produce a different picture. The first variant is the everyday look: a sample
 * that avoids every prayer and surah a rule names, so only the base rule (or the default) applies.
 */
import type { Condition, PlaylistRule, ThumbCondition, ThumbnailRule, ThumbnailVariant } from '@shared/types'
import { PRAYERS } from './prayers'
import { conditionKey, resolvePlaylists } from './rules'
import { DEFAULT_SURAHS, surahKey, translateSurah, type SurahDict } from './surahs'
import { describeLook, describeThumbRule, matchesThumbRule, resolveThumbnailLook, todayIso, type ThumbTarget } from './thumb-rules'

export interface Scenario { prayer: string; surahsAr: string[]; keywords: string[]; include: string[]; exclude: string[] }
type Avoid = { prayers?: ReadonlySet<string>; surahs?: ReadonlySet<string> }

const PREFERRED_PRAYERS = [...new Set(['Jumuah', 'Isha', 'Fajr', 'Maghrib', ...PRAYERS])]
const PREFERRED_SURAHS = ['الكهف', 'البقرة', 'يس', 'الملك', 'الرحمن', 'الفاتحة']

/** A concrete situation in which every condition holds for this reciter, or null when they can't all hold (e.g. another reciter, two different prayers). */
export function scenarioFor(conditions: readonly ThumbCondition[], reciterKey: string, surahs: SurahDict = DEFAULT_SURAHS, avoid: Avoid = {}): Scenario | null {
  let prayer: string | null = null
  const noPrayer = new Set<string>(), want = new Set<string>(), noSurah = new Set<string>(), noKeyword = new Set<string>()
  const keywords: string[] = [], include: string[] = [], exclude: string[] = []
  for (const c of conditions) {
    if (c.kind === 'playlist') { const id = c.value.trim(); if (id) (c.negate ? exclude : include).push(id); continue }
    const key = conditionKey(c as Condition)
    switch (c.kind) {
      case 'reciter': if ((key === reciterKey) === c.negate) return null; break
      case 'prayer': {
        const name = PRAYERS.find((p) => p.toLowerCase() === key) ?? c.value.trim()
        if (c.negate) noPrayer.add(name.toLowerCase())
        else if (prayer && prayer.toLowerCase() !== name.toLowerCase()) return null
        else prayer = name
        break
      }
      case 'surah': (c.negate ? noSurah : want).add(translateSurah(c.value, surahs)); break
      case 'keyword': if (c.negate) noKeyword.add(key); else if (!keywords.some((k) => surahKey(k) === key)) keywords.push(c.value.trim()); break
    }
  }
  if (prayer && noPrayer.has(prayer.toLowerCase())) return null
  if (!prayer) {
    const ok = (p: string) => !noPrayer.has(p.toLowerCase())
    prayer = PREFERRED_PRAYERS.find((p) => ok(p) && !avoid.prayers?.has(p.toLowerCase())) ?? PREFERRED_PRAYERS.find(ok) ?? null
    if (!prayer) return null
  }
  if (want.size > 3) return null
  for (const s of want) if (noSurah.has(s)) return null
  const surahsAr = [...want]
  if (!surahsAr.length) {
    const ok = (s: string) => !noSurah.has(s)
    const pick = PREFERRED_SURAHS.find((s) => ok(s) && !avoid.surahs?.has(s)) ?? PREFERRED_SURAHS.find(ok)
    if (!pick) return null
    surahsAr.push(pick)
  }
  for (const k of keywords) if (noKeyword.has(surahKey(k))) return null
  for (const p of include) if (exclude.includes(p)) return null
  return { prayer, surahsAr, keywords, include, exclude }
}

/** What the rules see for a scenario: playlists come from the playlist rules, plus the ones the conditions demand (a user can always add a playlist by hand). */
export function scenarioTarget(s: Scenario, reciterKey: string, playlistRules: readonly PlaylistRule[], surahs: SurahDict = DEFAULT_SURAHS): ThumbTarget {
  const tokens = { prayer: s.prayer, surahs: s.surahsAr, keywords: s.keywords }
  const auto = resolvePlaylists({ reciter: reciterKey, tokens }, playlistRules, surahs).final.filter((p) => !s.exclude.includes(p))
  return { reciter: reciterKey, tokens, playlists: [...new Set([...auto, ...s.include])] }
}

function describeScenario(s: Scenario, playlistName: (id: string) => string): string {
  const parts = [s.prayer, s.surahsAr.join(' + ')]
  for (const k of s.keywords) parts.push(`keyword “${k}”`)
  for (const p of s.include) parts.push(`in “${playlistName(p)}”`)
  return parts.join(' · ')
}

/** Everyday look first, then one entry per rule that can affect this reciter and changes the picture. */
export function reciterVariants(
  reciter: { key: string; folder: string },
  rules: readonly ThumbnailRule[],
  playlistRules: readonly PlaylistRule[],
  surahs: SurahDict = DEFAULT_SURAHS,
  playlistName: (id: string) => string = (id) => id,
  date: string = todayIso(),
): ThumbnailVariant[] {
  const candidates = rules.filter((r) => r.enabled && r.origin !== 'default' && r.conditions.length > 0)
  const claimed = { prayers: new Set<string>(), surahs: new Set<string>() }
  for (const r of candidates) for (const c of r.conditions) {
    if (c.negate) continue
    if (c.kind === 'prayer') claimed.prayers.add(conditionKey(c as Condition))
    if (c.kind === 'surah') claimed.surahs.add(translateSurah(c.value, surahs))
  }
  const out: ThumbnailVariant[] = []
  const seen = new Set<string>()
  const add = (id: string, title: string, s: Scenario): void => {
    const look = resolveThumbnailLook(scenarioTarget(s, reciter.key, playlistRules, surahs), rules, surahs)
    const sig = JSON.stringify([look.style ?? null, look.photo ?? null])
    if (seen.has(sig)) return   // same picture as an earlier variant
    seen.add(sig)
    out.push({
      id, title, look: describeLook(look, playlistName) ?? 'Plugin defaults', when: describeScenario(s, playlistName),
      sample: { folder: reciter.folder, surahsAr: s.surahsAr, prayer: s.prayer, date },
      ...(look.style ? { style: look.style } : {}), ...(look.photo ? { photo: look.photo } : {}),
    })
  }
  const base = scenarioFor([], reciter.key, surahs, claimed)
  if (base) add('base', 'Everyday look', base)
  for (const r of candidates) {
    const s = scenarioFor(r.conditions, reciter.key, surahs)
    if (!s || !matchesThumbRule(r, scenarioTarget(s, reciter.key, playlistRules, surahs), surahs)) continue
    add(r.id, describeThumbRule(r, playlistName), s)
  }
  return out
}
