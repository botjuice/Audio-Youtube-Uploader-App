import type { TokenValidation } from '@shared/types'
import type { Vocabulary } from './parse'
import { PRAYERS } from './prayers'
import { surahKey } from './surahs'

/**
 * A token can belong to exactly one vocabulary. Refuse anything that would be claimed by
 * another vocabulary first (or would swallow part of one); warn on overlaps within the same kind.
 */
export function validateToken(kind: 'keyword' | 'reciter', raw: string, vocab: Vocabulary): TokenValidation {
  const key = surahKey(raw)
  const bad = (error: string): TokenValidation => ({ ok: false, key, error })
  if (/[•#]/.test(raw)) return bad('Cannot contain • or #')
  if (/\d{1,2}\.\d{1,2}\.\d{4}/.test(raw)) return bad('Looks like a date')
  if (key.length < 2) return bad('Needs at least 2 letters or digits')
  if (PRAYERS.some((p) => p.toLowerCase() === key)) return bad(`“${raw}” is a prayer name`)
  if (key in vocab.surahs) return bad(`“${raw}” is already a surah spelling (${vocab.surahs[key]})`)

  const reciterToks = Object.values(vocab.reciters).flat()
  const keywordKeys = vocab.keywords.map(surahKey)
  const other = kind === 'keyword' ? reciterToks : keywordKeys
  const otherLabel = kind === 'keyword' ? 'a reciter name' : 'a keyword'
  const clash = other.find((t) => t === key || t.includes(key) || key.includes(t))
  if (clash) return bad(`Clashes with ${otherLabel} (“${clash}”)`)

  const same = kind === 'keyword' ? keywordKeys : reciterToks
  if (same.includes(key)) return bad('Already exists')
  const overlap = same.find((t) => t.includes(key) || key.includes(t))
  return overlap
    ? { ok: true, key, warning: `Overlaps with “${overlap}” — the longer one wins where both could match` }
    : { ok: true, key }
}
