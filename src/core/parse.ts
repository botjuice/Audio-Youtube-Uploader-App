import type { Parsed, ParseReason, Tokens } from '@shared/types'
import { PRAYERS, canonicalPrayer } from './prayers'
import { DEFAULT_SURAHS, surahKey, type SurahDict } from './surahs'

/** Everything the tokenizer may attribute. Build with buildVocabulary(). */
export interface Vocabulary {
  /** reciter key → every normalised spelling that identifies it (key itself + aliases) */
  reciters: Record<string, string[]>
  surahs: SurahDict
  /** canonical keyword names (as registered) */
  keywords: string[]
}

export const EMPTY_VOCAB: Vocabulary = { reciters: {}, surahs: DEFAULT_SURAHS, keywords: [] }

/** Folder name → reciter key: lowercase, alphanumerics only. */
export const reciterKey = (name: string) => surahKey(name)
/** @deprecated kept for callers that still want "folder name without spaces" */
export const prefixFromFolder = (folder: string) => folder.replace(/\s+/g, '')

export function buildVocabulary(
  reciters: { folder: string; aliases?: string[] }[],
  surahs: SurahDict = DEFAULT_SURAHS,
  keywords: string[] = [],
): Vocabulary {
  const r: Record<string, string[]> = {}
  for (const { folder, aliases = [] } of reciters) {
    const key = reciterKey(folder)
    if (!key) continue
    r[key] = [...new Set([key, ...aliases.map(surahKey).filter(Boolean)])]
  }
  return { reciters: r, surahs, keywords: keywords.filter((k) => k.trim()) }
}

// ── Dates ────────────────────────────────────────────────────────────────────

const DATE_RE = /(\d{1,2})[a-z]{0,2}\.(\d{1,2})[a-z]{0,2}\.(\d{4})(?!\d)/gi
const pad2 = (s: string) => String(Number.parseInt(s, 10)).padStart(2, '0')

/** '5.1.2025' → '05.01.2025' */
export function normaliseDate(raw: string): string {
  const [d = '', m = '', y = ''] = raw.split('.')
  return `${pad2(d)}.${pad2(m)}.${y}`
}

/** '14x.12.2024' → '14.12.2024'; null if it is not a date at all. */
export function cleanDateStr(raw: string): string | null {
  const parts = raw.split('.')
  if (parts.length !== 3) return null
  const [d, m, y] = parts.map((p) => p.replace(/\D/g, ''))
  if (!d || !m || !y || y.length !== 4) return null
  const dd = Number(d), mm = Number(m)
  if (dd < 1 || dd > 31 || mm < 1 || mm > 12) return null
  return `${pad2(d)}.${pad2(m)}.${y}`
}

// ── Tokenizer ────────────────────────────────────────────────────────────────

const SEPARATORS = new Set(['•', '-', '_', '#', ' ', '.', ',', '(', ')', '[', ']', '+', '~', '!', "'", '"'])
const isSep = (c: string) => SEPARATORS.has(c)
const isUpper = (c: string) => c !== c.toLowerCase() && c === c.toUpperCase()
const isLower = (c: string) => c !== c.toUpperCase() && c === c.toLowerCase()
const isDigit = (c: string) => c >= '0' && c <= '9'

interface Span { start: number; end: number }
type Kind = 'prayer' | 'reciter' | 'surah' | 'keyword'
interface Candidate { kind: Kind; len: number; value: string }
const PRECEDENCE: Record<Kind, number> = { prayer: 0, reciter: 1, surah: 2, keyword: 3 }

export interface Tokenized extends Tokens {
  /** original-index spans of leftovers and of the (first) date — used to build a fixed filename */
  leftoverSpans: Span[]
  dateSpan: Span | null
}

/** Word boundary inside glued text: separator/digit edge or a camelCase edge. */
function isBoundary(text: string, pos: number): boolean {
  if (pos === 0) return true
  const prev = text[pos - 1]!, cur = text[pos]!, next = text[pos + 1]
  if (isDigit(prev) !== isDigit(cur)) return true
  if (isUpper(cur) && isLower(prev)) return true
  if (isUpper(cur) && next !== undefined && isLower(next)) return true
  if (isLower(cur) && isUpper(prev)) return true
  return false
}

export function tokenize(stem: string, vocab: Vocabulary = EMPTY_VOCAB): Tokenized {
  const out: Tokenized = {
    date: null, dateDirty: false, prayer: null, reciter: null,
    surahs: [], keywords: [], leftovers: [], leftoverSpans: [], dateSpan: null,
  }
  const claimed: Span[] = []
  const addLeftover = (start: number, end: number) => {
    const text = stem.slice(start, end)
    if (!text.replace(/[\s•\-_#.,()[\]+~!'"]/g, '')) return
    out.leftovers.push(text); out.leftoverSpans.push({ start, end })
  }

  // 1. dates — first one wins, extra ones are leftovers
  for (const m of stem.matchAll(DATE_RE)) {
    const span = { start: m.index!, end: m.index! + m[0].length }
    const clean = cleanDateStr(m[0])
    if (!out.date && clean) {
      out.date = clean; out.dateDirty = /[a-z]/i.test(m[0]) || clean !== normaliseDateSafe(m[0]); out.dateSpan = span
    } else addLeftover(span.start, span.end)
    claimed.push(span)
  }

  // 2. split the rest into segments on separators (tokens never cross an explicit separator)
  const segments: { start: number; text: string }[] = []
  let cur = ''; let curStart = -1
  const flush = () => { if (cur) segments.push({ start: curStart, text: cur }); cur = ''; curStart = -1 }
  for (let i = 0; i < stem.length; i++) {
    if (claimed.some((s) => i >= s.start && i < s.end)) { flush(); continue }
    const c = stem[i]!
    if (isSep(c)) { flush(); continue }
    if (!cur) curStart = i
    cur += c
  }
  flush()

  // 3. longest-match tokenization within each segment
  const surahKeys = Object.keys(vocab.surahs).sort((a, b) => b.length - a.length)
  const keywordEntries = vocab.keywords.map((k) => ({ key: surahKey(k), name: k })).filter((k) => k.key).sort((a, b) => b.key.length - a.key.length)
  const reciterEntries = Object.entries(vocab.reciters).flatMap(([key, toks]) => toks.map((t) => ({ tok: t, key }))).sort((a, b) => b.tok.length - a.tok.length)

  for (const seg of segments) {
    const text = seg.text, lower = text.toLowerCase()
    let pos = 0, leftStart: number | null = null
    const best = (p: number): Candidate | null => {
      const cands: Candidate[] = []
      if (!out.prayer) for (const pr of PRAYERS) if (lower.startsWith(pr.toLowerCase(), p)) cands.push({ kind: 'prayer', len: pr.length, value: pr })
      for (const r of reciterEntries) if (lower.startsWith(r.tok, p)) { cands.push({ kind: 'reciter', len: r.tok.length, value: r.key }); break }
      for (const k of surahKeys) if (lower.startsWith(k, p)) { cands.push({ kind: 'surah', len: k.length, value: text.slice(p, p + k.length) }); break }
      for (const k of keywordEntries) if (lower.startsWith(k.key, p)) { cands.push({ kind: 'keyword', len: k.key.length, value: k.name }); break }
      if (!cands.length) return null
      cands.sort((a, b) => b.len - a.len || PRECEDENCE[a.kind] - PRECEDENCE[b.kind])
      return cands[0]!
    }
    while (pos < text.length) {
      const c = best(pos)
      const accept = c && (leftStart === null || isBoundary(text, pos))
      if (accept && c) {
        if (leftStart !== null) { addLeftover(seg.start + leftStart, seg.start + pos); leftStart = null }
        switch (c.kind) {
          case 'prayer': out.prayer = canonicalPrayer(c.value); break
          case 'reciter': if (out.reciter === null) out.reciter = c.value; else addLeftover(seg.start + pos, seg.start + pos + c.len); break
          case 'surah': out.surahs.push(c.value); break
          case 'keyword': if (!out.keywords.includes(c.value)) out.keywords.push(c.value); break
        }
        pos += c.len
      } else {
        if (leftStart === null) leftStart = pos
        pos++
      }
    }
    if (leftStart !== null) addLeftover(seg.start + leftStart, seg.start + text.length)
  }
  // keep leftovers in filename order
  const order = out.leftoverSpans.map((s, i) => [s.start, i] as const).sort((a, b) => a[0] - b[0]).map(([, i]) => i)
  out.leftovers = order.map((i) => out.leftovers[i]!); out.leftoverSpans = order.map((i) => out.leftoverSpans[i]!)
  return out
}

function normaliseDateSafe(raw: string): string | null {
  try { return normaliseDate(raw) } catch { return null }
}

// ── Fix suggestion ───────────────────────────────────────────────────────────

/** Rebuild the stem with leftovers removed and a dirty date cleaned; collapses separator runs. */
export function buildFixedStem(stem: string, t: Tokenized): string {
  const cuts = [...t.leftoverSpans].sort((a, b) => a.start - b.start)
  let out = ''; let i = 0; let capNext = false
  const dateSpan = t.dateSpan
  while (i < stem.length) {
    const cut = cuts.find((s) => s.start === i)
    // when a fragment is cut from inside glued text, re-capitalise the word that follows ("FINALmuminoon" → "Muminoon")
    if (cut) { capNext = out.length > 0 && /[A-Za-z]$/.test(out); i = cut.end; continue }
    if (dateSpan && i === dateSpan.start && t.date) { out += t.date; i = dateSpan.end; capNext = false; continue }
    const ch = stem[i]!
    out += capNext && /[a-z]/.test(ch) ? ch.toUpperCase() : ch
    capNext = false; i++
  }
  // collapse runs of separators: prefer '-', else the first in the run; trim at ends
  out = out.replace(/[•\-_#\s.,()[\]+~!'"]{2,}/g, (run) => (run.includes('-') ? '-' : run[0]!))
  // but never collapse the dots inside the date
  if (t.date) out = out.replace(t.date.replace(/\./g, '-'), t.date)
  return out.replace(/^[•\-_#\s.,()[\]+~!'"]+|[•\-_#\s.,()[\]+~!'"]+$/g, '')
}

// ── Diagnosis ────────────────────────────────────────────────────────────────

export interface Diagnosis {
  status: 'ready' | 'error'
  reason: ParseReason | null
  message: string | null
  /** stem with leftovers removed / date cleaned, or null if nothing to fix */
  suggestion: string | null
  /** true when applying `suggestion` alone makes the file Ready */
  fixable: boolean
  tokens: Tokens
  parsed: Parsed | null
}

export function diagnoseStem(stem: string, vocab: Vocabulary = EMPTY_VOCAB): Diagnosis {
  const t = tokenize(stem, vocab)
  const problems: { reason: ParseReason; text: string }[] = []
  if (!t.date) problems.push({ reason: 'NO_DATE', text: 'no date (expected DD.MM.YYYY)' })
  if (!t.prayer) problems.push({ reason: 'NO_PRAYER', text: `no prayer name (one of ${PRAYERS.join(', ')})` })
  if (t.surahs.length === 0) problems.push({ reason: 'NO_SURAH', text: 'no recognised surah' })
  if (t.leftovers.length) problems.push({ reason: 'LEFTOVER', text: `unrecognised: ${t.leftovers.map((l) => `“${l}”`).join(', ')}` })

  // Only offer a rename that keeps a surah — never suggest stripping the one word that might be the surah.
  const hasFix = (t.leftovers.length > 0 && t.surahs.length > 0) || t.dateDirty
  const suggestion = hasFix ? buildFixedStem(stem, t) : null
  const tokens: Tokens = { date: t.date, dateDirty: t.dateDirty, prayer: t.prayer, reciter: t.reciter, surahs: t.surahs, keywords: t.keywords, leftovers: t.leftovers }

  if (problems.length === 0 && !t.dateDirty) {
    return { status: 'ready', reason: null, message: null, suggestion: null, fixable: false, tokens,
      parsed: { date: t.date!, prayer: t.prayer!, reciter: t.reciter, surahs: t.surahs, keywords: t.keywords } }
  }
  const onlyFixable = problems.every((p) => p.reason === 'LEFTOVER')
  const message = problems.length ? problems.map((p) => p.text).join(' · ') : 'date needs cleaning'
  return {
    status: 'error',
    reason: problems[0]?.reason ?? 'NO_DATE',
    message: message.charAt(0).toUpperCase() + message.slice(1),
    suggestion, fixable: hasFix && onlyFixable, tokens, parsed: null,
  }
}
