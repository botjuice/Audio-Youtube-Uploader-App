import type { Parsed, PlaylistOverrides, PlaylistRule } from '@shared/types'
import { surahKey } from './surahs'

export interface RuleTarget {
  reciterFolder: string
  stem: string
  parsed: Parsed | null
}

const norm = (s: string) => s.trim().toLowerCase()

export function matchesRule(rule: PlaylistRule, t: RuleTarget): boolean {
  if (!rule.enabled || !rule.playlistId || !rule.value.trim()) return false
  switch (rule.match) {
    case 'reciter':
      return norm(rule.value).replace(/\s+/g, '') === norm(t.reciterFolder).replace(/\s+/g, '')
    case 'prayer':
      return !!t.parsed && norm(t.parsed.prayer) === norm(rule.value)
    case 'surah':
      return !!t.parsed && t.parsed.surahs.some((s) => surahKey(s) === surahKey(rule.value))
    case 'keyword':
      return norm(t.stem).includes(norm(rule.value))
  }
}

const dedupe = (ids: string[]) => [...new Set(ids.filter(Boolean))]

export function resolvePlaylists(
  t: RuleTarget,
  rules: readonly PlaylistRule[],
  overrides: PlaylistOverrides = { include: [], exclude: [] },
): { auto: string[]; final: string[] } {
  const auto = dedupe(rules.filter((r) => matchesRule(r, t)).map((r) => r.playlistId))
  const final = dedupe([...auto.filter((id) => !overrides.exclude.includes(id)), ...overrides.include])
  return { auto, final }
}
