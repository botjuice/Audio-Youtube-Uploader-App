/**
 * Every final thumbnail look a recording can actually get.
 *
 * A look is the base rule plus every overlay the recording matches, so the question "what can this
 * overlay look like?" is really "which base + overlay combinations are reachable?". Rather than reason
 * about rules, enumerate situations: for each reciter, every prayer a condition names plus one neutral
 * prayer, every surah a condition names plus one neutral surah (in combinations of up to three), and
 * every keyword a condition names, on or off. Playlists are whatever the playlist rules grant that
 * situation — never a manual override. Each situation resolves to one look; situations that end in the
 * same look are merged, keeping the simplest (neutral-first) sample. A few thousand cheap checks at most.
 */
import type { Condition, PlaylistRule, ReciterInfo, StylePatch, ThumbnailRule, ThumbnailSample, ThumbnailVariant } from '@shared/types'
import { PRAYERS } from './prayers'
import { conditionKey, resolvePlaylists } from './rules'
import { DEFAULT_SURAHS, translateSurah, type SurahDict } from './surahs'
import { describeLook, resolveThumbnailLook, todayIso, type ThumbTarget, type ThumbnailLook } from './thumb-rules'

type Reciter = Pick<ReciterInfo, 'key' | 'folder'>
export interface Situation { prayer: string; surahsAr: string[]; keywords: string[] }
interface Domain { prayers: string[]; surahs: string[]; keywords: string[] }

const PREFERRED_PRAYERS = [...new Set(['Jumuah', 'Isha', 'Fajr', 'Maghrib', ...PRAYERS])]
const PREFERRED_SURAHS = ['الكهف', 'البقرة', 'يس', 'الملك', 'الرحمن', 'الفاتحة']
/** Caps so a library with many surah/keyword conditions stays instant (rare; the rest is simply not explored). */
const MAX_SURAH_COMBOS = 120
const MAX_KEYWORDS = 6

/** The values any condition mentions (thumbnail and playlist rules). Only these, plus one neutral value each, can change a look. Neutral values come first. */
export function situationDomain(rules: readonly ThumbnailRule[], playlistRules: readonly PlaylistRule[], surahs: SurahDict = DEFAULT_SURAHS): Domain {
  const prayers = new Set<string>(), named = new Set<string>(), keywords = new Map<string, string>()
  for (const c of [...rules.flatMap((r) => r.conditions), ...playlistRules.flatMap((r) => r.conditions)]) {
    if (c.kind === 'playlist' || c.kind === 'reciter' || !c.value.trim()) continue
    const key = conditionKey(c as Condition)
    if (c.kind === 'prayer') prayers.add(PRAYERS.find((p) => p.toLowerCase() === key) ?? c.value.trim())
    else if (c.kind === 'surah') named.add(translateSurah(c.value, surahs))
    else if (!keywords.has(key)) keywords.set(key, c.value.trim())
  }
  const neutralPrayer = PREFERRED_PRAYERS.find((p) => !prayers.has(p))
  const neutralSurah = PREFERRED_SURAHS.find((s) => !named.has(s)) ?? Object.values(surahs).find((s) => !named.has(s))
  return {
    prayers: [...new Set([...(neutralPrayer ? [neutralPrayer] : []), ...prayers])],
    surahs: [...new Set([...(neutralSurah ? [neutralSurah] : []), ...named])],
    keywords: [...keywords.values()].slice(0, MAX_KEYWORDS),
  }
}

/** Combinations of 1..3 surahs, smallest first, neutral first within a size. */
function surahCombos(surahs: readonly string[]): string[][] {
  const out: string[][] = []
  const rec = (start: number, acc: string[]) => {
    if (out.length >= MAX_SURAH_COMBOS) return
    if (acc.length) out.push(acc)
    if (acc.length === 3) return
    for (let i = start; i < surahs.length; i++) rec(i + 1, [...acc, surahs[i]!])
  }
  rec(0, [])
  return out.sort((a, b) => a.length - b.length)   // stable: keeps neutral-first order within a size
}

function keywordSets(keywords: readonly string[]): string[][] {
  const out: string[][] = [[]]
  for (const k of keywords) out.push(...out.map((s) => [...s, k]))
  return out.sort((a, b) => a.length - b.length)
}

/** Every situation worth checking, simplest first (so the first look found for a reciter is the everyday one). */
export function situations(d: Domain): Situation[] {
  const out: Situation[] = []
  for (const keywords of keywordSets(d.keywords)) for (const surahsAr of surahCombos(d.surahs)) for (const prayer of d.prayers) out.push({ prayer, surahsAr, keywords })
  return out
}

/** What the rules see for a situation: playlists come from the playlist rules only. */
export function situationTarget(reciterKey: string, s: Situation, playlistRules: readonly PlaylistRule[], surahs: SurahDict = DEFAULT_SURAHS): ThumbTarget {
  const tokens = { prayer: s.prayer, surahs: s.surahsAr, keywords: s.keywords }
  return { reciter: reciterKey, tokens, playlists: resolvePlaylists({ reciter: reciterKey, tokens }, playlistRules, surahs).final }
}

export const sampleTarget = (sample: ThumbnailSample, reciterKey: string, playlistRules: readonly PlaylistRule[], surahs: SurahDict = DEFAULT_SURAHS): ThumbTarget =>
  situationTarget(reciterKey, { prayer: sample.prayer, surahsAr: sample.surahsAr, keywords: sample.keywords ?? [] }, playlistRules, surahs)

/** One id per (reciter, base, overlay set) — the identity of a final look. */
export const lookSignature = (reciterKey: string, look: Pick<ThumbnailLook, 'base' | 'overlays'>): string =>
  JSON.stringify([reciterKey, look.base?.id ?? null, look.overlays.map((o) => o.id)])

const pictureKey = (v: Pick<ThumbnailVariant, 'reciter' | 'style' | 'photo'>): string => JSON.stringify([v.reciter, v.style ?? null, v.photo ?? null])

function describeSituation(s: Situation, playlists: readonly string[], playlistName: (id: string) => string): string {
  const parts = [s.prayer, s.surahsAr.join(' + ')]
  for (const k of s.keywords) parts.push(`keyword “${k}”`)
  for (const p of playlists) parts.push(`in “${playlistName(p)}”`)
  return parts.join(' · ')
}

/** Every reachable final look, per reciter, each with the simplest sample that produces it. */
export function enumerateLooks(
  reciters: readonly Reciter[],
  rules: readonly ThumbnailRule[],
  playlistRules: readonly PlaylistRule[],
  surahs: SurahDict = DEFAULT_SURAHS,
  playlistName: (id: string) => string = (id) => id,
  date: string = todayIso(),
): ThumbnailVariant[] {
  const all = situations(situationDomain(rules, playlistRules, surahs))
  const out: ThumbnailVariant[] = []
  const seen = new Set<string>()
  for (const r of reciters) for (const s of all) {
    const t = situationTarget(r.key, s, playlistRules, surahs)
    const look = resolveThumbnailLook(t, rules, surahs)
    const id = lookSignature(r.key, look)
    if (seen.has(id)) continue
    seen.add(id)
    out.push({
      id, reciter: r.folder, baseId: look.base?.id ?? null, overlayIds: look.overlays.map((o) => o.id),
      look: describeLook(look, playlistName) ?? 'Plugin defaults', when: describeSituation(s, t.playlists, playlistName),
      sample: { folder: r.folder, surahsAr: s.surahsAr, prayer: s.prayer, date, ...(s.keywords.length ? { keywords: s.keywords } : {}) },
      ...(look.style ? { style: look.style as StylePatch } : {}), ...(look.photo ? { photo: look.photo } : {}),
    })
  }
  return out
}

/** Drop entries that would render the same picture as an earlier one (same reciter, knobs and photo). */
export function mergeSamePicture(variants: readonly ThumbnailVariant[]): ThumbnailVariant[] {
  const seen = new Set<string>()
  return variants.filter((v) => { const k = pictureKey(v); if (seen.has(k)) return false; seen.add(k); return true })
}

/** The looks one reciter's recordings can get; the first is the everyday look. */
export const looksForReciter = (all: readonly ThumbnailVariant[], folder: string): ThumbnailVariant[] => mergeSamePicture(all.filter((v) => v.reciter === folder))

/** The final looks that include a given overlay. */
export const looksForOverlay = (all: readonly ThumbnailVariant[], ruleId: string): ThumbnailVariant[] => mergeSamePicture(all.filter((v) => v.overlayIds.includes(ruleId)))

/** Which of `options` a saved sample currently lands on: undefined when the sample no longer produces any of them,
 *  or (with `ruleId`) when the sample doesn't actually trigger that overlay — even if the picture would be the same. */
export function variantForSample(
  options: readonly ThumbnailVariant[], all: readonly ThumbnailVariant[], sample: ThumbnailSample,
  reciters: readonly Reciter[], rules: readonly ThumbnailRule[], playlistRules: readonly PlaylistRule[], surahs: SurahDict = DEFAULT_SURAHS, ruleId?: string,
): ThumbnailVariant | undefined {
  const r = reciters.find((x) => x.folder === sample.folder)
  if (!r) return undefined
  const look = resolveThumbnailLook(sampleTarget(sample, r.key, playlistRules, surahs), rules, surahs)
  if (ruleId && !look.overlays.some((o) => o.id === ruleId)) return undefined
  const raw = all.find((v) => v.id === lookSignature(r.key, look))
  if (!raw) return undefined
  const key = pictureKey(raw)
  return options.find((v) => pictureKey(v) === key)
}

/** The final look a rule's sample recording gets (what the editor paints for an overlay), or null when the sample names no reciter. */
export function resolveSampleLook(sample: ThumbnailSample, reciters: readonly Reciter[], rules: readonly ThumbnailRule[], playlistRules: readonly PlaylistRule[], surahs: SurahDict = DEFAULT_SURAHS): ThumbnailLook | null {
  const r = reciters.find((x) => x.folder === sample.folder) ?? reciters[0]
  return r ? resolveThumbnailLook(sampleTarget(sample, r.key, playlistRules, surahs), rules, surahs) : null
}

/** For an overlay rule: the looks it can be part of, and which one its sample shows (falling back to the first). */
export function overlayPreview(
  all: readonly ThumbnailVariant[], rule: Pick<ThumbnailRule, 'id' | 'sample'>,
  reciters: readonly Reciter[], rules: readonly ThumbnailRule[], playlistRules: readonly PlaylistRule[], surahs: SurahDict = DEFAULT_SURAHS,
): { options: ThumbnailVariant[]; current: ThumbnailVariant | undefined; sampleFits: boolean } {
  const options = looksForOverlay(all, rule.id)
  const hit = variantForSample(options, all, rule.sample, reciters, rules, playlistRules, surahs, rule.id)
  return { options, current: hit ?? options[0], sampleFits: !!hit }
}
