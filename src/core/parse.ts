import type { Parsed, ParseReason } from '@shared/types'
import { PRAYERS_ALTERNATION, canonicalPrayer } from './prayers'
import { DEFAULT_SURAHS, isKnownSurah, type SurahDict } from './surahs'

const FILENAME_RE = new RegExp(
  `^(${PRAYERS_ALTERNATION})(.+?)-(\\d{1,2}\\.\\d{1,2}\\.\\d{4})$`, 'i')
const PRAYER_ANYWHERE_RE = new RegExp(`(${PRAYERS_ALTERNATION})`, 'i')
const DATE_LOOSE_RE = /\d{1,2}\.\d{1,2}\.\d{4}$/
const DATE_DIRTY_RE = /\w+\.\w+\.\d{4}$/      // e.g. 14x.12.2024

const pad2 = (s: string) => String(Number.parseInt(s, 10)).padStart(2, '0')

/** '5.1.2025' → '05.01.2025' */
export function normaliseDate(raw: string): string {
  const [d = '', m = '', y = ''] = raw.split('.')
  return `${pad2(d)}.${pad2(m)}.${y}`
}

/** '14x.12.2024' → '14.12.2024'; null if unrecoverable. */
export function cleanDateStr(raw: string): string | null {
  const parts = raw.split('.')
  if (parts.length !== 3) return null
  const cleaned = parts.map((p) => p.replace(/\D/g, ''))
  const [d, m, y] = cleaned
  if (!d || !m || !y || y.length !== 4) return null
  return `${pad2(d)}.${pad2(m)}.${y}`
}

/** Derive the filename prefix from a folder name: spaces removed. */
export function prefixFromFolder(folder: string): string {
  return folder.replace(/\s+/g, '')
}

export function stripPrefix(stem: string, prefix: string): string | null {
  return stem.toLowerCase().startsWith(prefix.toLowerCase()) ? stem.slice(prefix.length) : null
}

export function parseStem(stem: string, prefix: string): Parsed | null {
  const rest = stripPrefix(stem, prefix)
  if (rest === null) return null
  const m = FILENAME_RE.exec(rest)
  if (!m) return null
  const prayer = canonicalPrayer(m[1]!)
  if (!prayer) return null
  return {
    prayer,
    surahs: m[2]!.split('•').filter(Boolean),
    date: normaliseDate(m[3]!),
  }
}

export function buildStem(prefix: string, prayer: string, surahs: string[], date: string): string {
  return `${prefix}${prayer}${surahs.join('•')}-${date}`
}

// ── Surah-name analysis ──────────────────────────────────────────────────────

const isUpper = (c: string) => c === c.toUpperCase() && c !== c.toLowerCase()
const isLower = (c: string) => c === c.toLowerCase() && c !== c.toUpperCase()
const isAllUpper = (s: string) => s === s.toUpperCase() && s !== s.toLowerCase()

/**
 * 'FINALmuminoon' → ['FINAL','Muminoon'] · 'OUTSIDENahl' → ['OUTSIDE','Nahl']
 * 'OlayanNisaa' → ['Olayan','Nisaa'] · 'THashr' → ['T','Hashr']
 */
export function stripLeadingDescriptor(surah: string, dict: SurahDict = DEFAULT_SURAHS): [string, string] | null {
  // Strategy 1: ALLCAPS run followed by lowercase → strip the whole caps run
  const m = /^([A-Z]{2,})([a-z].+)$/.exec(surah)
  if (m) {
    const remainder = m[2]![0]!.toUpperCase() + m[2]!.slice(1)
    if (isKnownSurah(remainder, dict)) return [m[1]!, remainder]
  }
  // Strategy 2: scan for an uppercase-led suffix that is a known surah, never cutting through a caps run
  for (let i = 1; i < surah.length; i++) {
    const candidate = surah.slice(i)
    const prefix = surah.slice(0, i)
    if (isUpper(candidate[0]!) && (isLower(prefix[prefix.length - 1]!) || isAllUpper(prefix))) {
      if (isKnownSurah(candidate, dict)) return [prefix, candidate]
    }
  }
  return null
}

/** 'ShamsLayl' → ['Shams','Layl'] · 'GhafirFiroun' → ['Ghafir','Firoun'] */
export function splitMissingSeparator(surah: string, dict: SurahDict = DEFAULT_SURAHS): [string, string] | null {
  for (let len = surah.length - 1; len > 1; len--) {
    const candidate = surah.slice(0, len)
    if (isKnownSurah(candidate, dict)) {
      const rest = surah.slice(len)
      if (rest) return [candidate, rest]
    }
  }
  return null
}

export interface SurahAnalysis { clean: string[] | null; issue: string | null }

export function analyseSurah(surah: string, dict: SurahDict = DEFAULT_SURAHS): SurahAnalysis {
  if (isKnownSurah(surah, dict)) return { clean: [surah], issue: null }

  // Two surahs merged without '•' — check FIRST so 'Shams' in 'ShamsLayl' is a surah, not a descriptor
  const split = splitMissingSeparator(surah, dict)
  if (split) {
    const [first, rest] = split
    if (isKnownSurah(rest, dict)) {
      return { clean: [first, rest], issue: `'${surah}' — two surahs without '•', split into '${first}•${rest}'` }
    }
    return { clean: [first], issue: `'${surah}' — trailing descriptor '${rest}' removed` }
  }

  const stripped = stripLeadingDescriptor(surah, dict)
  if (stripped) {
    const [desc, real] = stripped
    return { clean: [real], issue: `'${surah}' — leading descriptor '${desc}' removed` }
  }

  return { clean: null, issue: `'${surah}' is not a recognised surah — add it as an alias or rename` }
}

// ── Full diagnosis of one filename stem ──────────────────────────────────────

export interface Diagnosis {
  status: 'ready' | 'fix' | 'error'
  reason: ParseReason | null
  message: string | null
  /** Suggested replacement stem (without extension) when auto-fixable. */
  suggestion: string | null
  parsed: Parsed | null
}

const ok = (parsed: Parsed): Diagnosis => ({ status: 'ready', reason: null, message: null, suggestion: null, parsed })
const fix = (reason: ParseReason, message: string, suggestion: string | null, parsed: Parsed | null = null): Diagnosis =>
  ({ status: suggestion ? 'fix' : 'error', reason, message, suggestion, parsed })

export function diagnoseStem(stem: string, prefix: string, dict: SurahDict = DEFAULT_SURAHS): Diagnosis {
  const rest = stripPrefix(stem, prefix)
  if (rest === null) {
    return fix('PREFIX_MISMATCH', `Filename must start with '${prefix}' (the folder name without spaces)`, null)
  }

  const prayerMatch = PRAYER_ANYWHERE_RE.exec(rest)
  if (!prayerMatch) {
    const dirty = DATE_DIRTY_RE.exec(rest)
    const hint = dirty && cleanDateStr(dirty[0]) ? ` (date would be cleaned to ${cleanDateStr(dirty[0])})` : ''
    return fix('NO_PRAYER', `No prayer name found in '${rest}'${hint}. Add one of: ${PRAYERS_ALTERNATION.replaceAll('|', ', ')}`, null)
  }

  const prayer = canonicalPrayer(prayerMatch[1]!)!
  if (prayerMatch.index !== 0) {
    const before = rest.slice(0, prayerMatch.index)
    const dateM = DATE_LOOSE_RE.exec(rest) ?? DATE_DIRTY_RE.exec(rest)
    let suggestion: string | null = null
    if (dateM) {
      const date = cleanDateStr(dateM[0]) ?? dateM[0]
      suggestion = `${prefix}${prayer}${before.replace(/-+$/, '')}-${date}`
    }
    return fix('PRAYER_ORDER', `Prayer '${prayer}' comes after the surah '${before}' — order is reversed`, suggestion)
  }

  const parsed = parseStem(stem, prefix)
  if (!parsed) {
    const dateM = DATE_DIRTY_RE.exec(rest)
    let suggestion: string | null = null
    if (dateM) {
      const fixed = cleanDateStr(dateM[0])
      const dash = rest.lastIndexOf('-')
      if (fixed && dash > prayerMatch[0].length) {
        const surahPart = rest.slice(prayerMatch[0].length, dash)
        suggestion = `${prefix}${prayer}${surahPart}-${fixed}`
      }
    }
    return fix('BAD_DATE', `Date is missing or malformed in '${rest}' — expected DD.MM.YYYY at the end`, suggestion)
  }

  const allClean: string[] = []
  const issues: string[] = []
  let unresolved = false
  let needsRename = false
  for (const s of parsed.surahs) {
    const { clean, issue } = analyseSurah(s, dict)
    if (clean === null) { unresolved = true; needsRename = true; issues.push(issue!); allClean.push(s) }
    else if (issue) { needsRename = true; issues.push(issue); allClean.push(...clean) }
    else allClean.push(...clean)
  }

  if (!needsRename) return ok(parsed)
  if (unresolved) return fix('UNKNOWN_SURAH', issues.join('; '), null, parsed)
  return fix('SURAH_FIXABLE', issues.join('; '), buildStem(prefix, parsed.prayer, allClean, parsed.date), parsed)
}
