import type { Condition, ConditionKind, PlaylistOverrides, PlaylistRule, Tokens } from '@shared/types'
import { reciterKey } from './parse'
import { PRAYERS, canonicalPrayer } from './prayers'
import { DEFAULT_SURAHS, surahKey, translateSurah, type SurahDict } from './surahs'

export const MAX_CONDITIONS = 3
/** Fields a recording has exactly one of (so two positive conditions on them can never both hold). */
const SINGLE_VALUED: ReadonlySet<ConditionKind> = new Set(['reciter', 'prayer'])

export interface RuleTarget {
  reciter: string | null
  tokens: Pick<Tokens, 'prayer' | 'surahs' | 'keywords'>
}

/** Normalised comparison value for a condition (so "Abdullah Al Mousa" == "abdullahalmousa"). */
export function conditionKey(c: Pick<Condition, 'kind' | 'value'>): string {
  switch (c.kind) {
    case 'reciter': return reciterKey(c.value)
    case 'prayer':  return (canonicalPrayer(c.value) ?? c.value).toLowerCase()
    case 'surah':   return surahKey(c.value)
    case 'keyword': return surahKey(c.value)
  }
}

export function conditionHolds(c: Condition, t: RuleTarget, surahs: SurahDict = DEFAULT_SURAHS): boolean {
  const key = conditionKey(c)
  let hit: boolean
  switch (c.kind) {
    case 'reciter': hit = !!t.reciter && t.reciter === key; break
    case 'prayer':  hit = !!t.tokens.prayer && t.tokens.prayer.toLowerCase() === key; break
    case 'surah': { // any spelling of the same surah: compare the Arabic the dictionary maps them to
      const want = translateSurah(c.value, surahs)
      hit = t.tokens.surahs.some((s) => translateSurah(s, surahs) === want); break
    }
    case 'keyword': hit = t.tokens.keywords.some((k) => surahKey(k) === key); break
  }
  return c.negate ? !hit : hit
}

export function matchesRule(rule: PlaylistRule, t: RuleTarget, surahs: SurahDict = DEFAULT_SURAHS): boolean {
  if (!rule.enabled || !rule.playlistId || rule.conditions.length === 0) return false
  return rule.conditions.every((c) => conditionHolds(c, t, surahs))
}

/** Problems that make a rule unsaveable. Empty array = valid. */
export function validateRule(rule: Pick<PlaylistRule, 'conditions' | 'playlistId'>, surahs: SurahDict = DEFAULT_SURAHS): string[] {
  const errors: string[] = []
  const cs = rule.conditions
  if (!rule.playlistId) errors.push('Choose a playlist')
  if (cs.length === 0) errors.push('Add at least one condition')
  if (cs.length > MAX_CONDITIONS) errors.push(`At most ${MAX_CONDITIONS} conditions`)
  if (cs.some((c) => !c.value.trim())) errors.push('Every condition needs a value')
  if (cs.length && !cs.some((c) => !c.negate)) errors.push('At least one condition must be “is” — a rule made only of “is not” would match almost everything')
  for (const kind of SINGLE_VALUED) {
    const positives = cs.filter((c) => c.kind === kind && !c.negate)
    if (positives.length > 1 && new Set(positives.map(conditionKey)).size > 1) errors.push(`A recording has only one ${kind} — two different “${kind} is” conditions can never both be true`)
  }
  for (const c of cs) {
    if (c.negate) continue
    const contradiction = cs.find((o) => o !== c && o.negate && o.kind === c.kind && conditionKey(o) === conditionKey(c))
    if (contradiction) { errors.push(`“${c.kind} is ${c.value}” and “${c.kind} is not ${contradiction.value}” contradict each other`); break }
  }
  if (cs.some((c) => c.kind === 'prayer' && c.value.trim() && !canonicalPrayer(c.value))) errors.push(`Unknown prayer — choose one of ${PRAYERS.join(', ')}`)
  const badSurah = cs.find((c) => c.kind === 'surah' && c.value.trim() && !(surahKey(c.value) in surahs))
  if (badSurah) errors.push(`“${badSurah.value}” is not a known surah spelling`)
  return errors
}

export const KIND_LABEL: Record<ConditionKind, string> = { reciter: 'Reciter', prayer: 'Prayer', surah: 'Surah', keyword: 'Keyword' }

/** "Reciter is Abdullah Al Mousa · Prayer is not Taraweeh" */
export function describeRule(rule: Pick<PlaylistRule, 'conditions' | 'label'>): string {
  if (rule.label?.trim()) return rule.label.trim()
  return rule.conditions.map((c) => `${KIND_LABEL[c.kind]} ${c.negate ? 'is not' : 'is'} ${c.value || '…'}`).join(' · ')
}

const dedupe = (ids: string[]) => [...new Set(ids.filter(Boolean))]

export interface Resolution {
  auto: string[]
  final: string[]
  /** playlistId → ids of the rules that added it */
  via: Record<string, string[]>
}

export function resolvePlaylists(
  t: RuleTarget,
  rules: readonly PlaylistRule[],
  surahs: SurahDict = DEFAULT_SURAHS,
  overrides: PlaylistOverrides = { include: [], exclude: [] },
): Resolution {
  const via: Record<string, string[]> = {}
  for (const r of rules) if (matchesRule(r, t, surahs)) (via[r.playlistId] ??= []).push(r.id)
  const auto = dedupe(Object.keys(via))
  const final = dedupe([...auto.filter((id) => !overrides.exclude.includes(id)), ...overrides.include])
  return { auto, final, via }
}
