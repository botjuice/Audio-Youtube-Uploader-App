import type { KeywordDef, PlaylistOverrides, PlaylistRule, Tokens } from '@shared/types'
import { reciterKey } from './parse'
import { surahKey } from './surahs'

/** What rules look at: the effective reciter plus whatever the name yielded. */
export interface RuleTarget {
  reciter: string | null
  tokens: Pick<Tokens, 'prayer' | 'surahs' | 'keywords'>
}

const norm = (s: string) => s.trim().toLowerCase()

export function matchesRule(rule: PlaylistRule, t: RuleTarget): boolean {
  if (!rule.enabled || !rule.playlistId || !rule.value.trim()) return false
  switch (rule.match) {
    case 'reciter': return !!t.reciter && reciterKey(rule.value) === t.reciter
    case 'prayer':  return !!t.tokens.prayer && norm(t.tokens.prayer) === norm(rule.value)
    case 'surah':   return t.tokens.surahs.some((s) => surahKey(s) === surahKey(rule.value))
  }
}

const dedupe = (ids: string[]) => [...new Set(ids.filter(Boolean))]

export function resolvePlaylists(
  t: RuleTarget,
  rules: readonly PlaylistRule[],
  keywords: readonly KeywordDef[] = [],
  overrides: PlaylistOverrides = { include: [], exclude: [] },
): { auto: string[]; final: string[] } {
  const fromRules = rules.filter((r) => matchesRule(r, t)).map((r) => r.playlistId)
  const fromKeywords = t.tokens.keywords.flatMap((k) => keywords.find((d) => surahKey(d.name) === surahKey(k))?.playlistIds ?? [])
  const auto = dedupe([...fromRules, ...fromKeywords])
  const final = dedupe([...auto.filter((id) => !overrides.exclude.includes(id)), ...overrides.include])
  return { auto, final }
}
