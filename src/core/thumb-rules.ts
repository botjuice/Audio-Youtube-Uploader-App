/**
 * Thumbnail rules: which look a recording gets.
 *
 * Same condition engine as playlist rules plus a `playlist` condition (the playlists the recording
 * resolves to). Rules are tried in list order; the first enabled match wins. The one rule with
 * `origin: 'default'` has no conditions and applies when nothing else matches.
 */
import type { Condition, StylePatch, ThumbCondition, ThumbConditionKind, ThumbnailRule, ThumbnailSample } from '@shared/types'
import { KIND_LABEL, conditionHolds, conditionKey, conditionProblems, type RuleTarget } from './rules'
import { DEFAULT_SURAHS, type SurahDict } from './surahs'

export const DEFAULT_RULE_ID = 'default'

export interface ThumbTarget extends RuleTarget {
  /** playlist ids the recording will be added to (rules + manual overrides) */
  playlists: readonly string[]
}

export const THUMB_KIND_LABEL: Record<ThumbConditionKind, string> = { ...KIND_LABEL, playlist: 'Playlist' }

export const thumbConditionKey = (c: Pick<ThumbCondition, 'kind' | 'value'>): string =>
  c.kind === 'playlist' ? c.value.trim() : conditionKey(c as Pick<Condition, 'kind' | 'value'>)

export function thumbConditionHolds(c: ThumbCondition, t: ThumbTarget, surahs: SurahDict = DEFAULT_SURAHS): boolean {
  if (c.kind === 'playlist') { const hit = t.playlists.includes(c.value.trim()); return c.negate ? !hit : hit }
  return conditionHolds(c as Condition, t, surahs)
}

/** True when the rule is enabled, has conditions, and every condition holds. The default rule never "matches". */
export function matchesThumbRule(rule: ThumbnailRule, t: ThumbTarget, surahs: SurahDict = DEFAULT_SURAHS): boolean {
  if (!rule.enabled || rule.conditions.length === 0) return false
  return rule.conditions.every((c) => thumbConditionHolds(c, t, surahs))
}

/** The base look: first matching non-overlay rule in list order, else the default rule, else null (no rules at all). */
export function resolveThumbnailRule(t: ThumbTarget, rules: readonly ThumbnailRule[], surahs: SurahDict = DEFAULT_SURAHS): ThumbnailRule | null {
  return rules.find((r) => r.origin !== 'default' && !r.overlay && matchesThumbRule(r, t, surahs)) ?? rules.find((r) => r.origin === 'default') ?? null
}

/** Every matching overlay rule, in list order (later ones win on the same knob). */
export function matchingOverlays(t: ThumbTarget, rules: readonly ThumbnailRule[], surahs: SurahDict = DEFAULT_SURAHS): ThumbnailRule[] {
  return rules.filter((r) => r.overlay && r.origin !== 'default' && matchesThumbRule(r, t, surahs))
}

export interface ThumbnailLook {
  base: ThumbnailRule | null
  overlays: ThumbnailRule[]
  /** the base rule's custom background file name, if any (overlays never change the photo) */
  photo?: string
  /** base patch with every overlay's changed knobs layered on top; undefined = plugin defaults */
  style: StylePatch | undefined
}

/** Deep-merge style patches: knobs set in `over` replace those in `base`; groups are merged, not replaced. */
export function mergePatches(base: StylePatch, over: StylePatch): StylePatch {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    const b = out[k]
    out[k] = v !== null && typeof v === 'object' && b !== null && typeof b === 'object' ? mergePatches(b as StylePatch, v as StylePatch) : v
  }
  return out as StylePatch
}

/**
 * The look a recording gets. Every rule inherits the Default look: the winning base rule's changes are
 * laid over the default rule's style, then matching overlays on top. Only a normal (non-default,
 * non-overlay) base rule can bring its own background image.
 */
export function resolveThumbnailLook(t: ThumbTarget, rules: readonly ThumbnailRule[], surahs: SurahDict = DEFAULT_SURAHS): ThumbnailLook {
  const def = rules.find((r) => r.origin === 'default')
  const base = resolveThumbnailRule(t, rules, surahs)
  const overlays = matchingOverlays(t, rules, surahs)
  const start = base && base !== def ? mergePatches(def?.style ?? {}, base.style) : (base?.style ?? {})
  const merged = overlays.reduce((acc, r) => mergePatches(acc, r.style), start)
  return { base, overlays, style: isEmptyPatch(merged) ? undefined : merged, ...(base?.photo && !base.overlay && base.origin !== 'default' ? { photo: base.photo } : {}) }
}

/** Effective style of a rule for display: the Default look under a normal rule's or an overlay's changes. */
export function effectiveStyle(rule: Pick<ThumbnailRule, 'style' | 'origin'>, rules: readonly ThumbnailRule[]): StylePatch {
  if (rule.origin === 'default') return rule.style
  return mergePatches(rules.find((r) => r.origin === 'default')?.style ?? {}, rule.style)
}

/** The style patch to send with a recording's job (undefined = plugin defaults). */
export function resolveThumbnailStyle(t: ThumbTarget, rules: readonly ThumbnailRule[], surahs: SurahDict = DEFAULT_SURAHS): { rule: ThumbnailRule | null; style: StylePatch | undefined } {
  const look = resolveThumbnailLook(t, rules, surahs)
  return { rule: look.base, style: look.style }
}

/** "Default look + Taraweeh gold" */
export function describeLook(look: Pick<ThumbnailLook, 'base' | 'overlays'>, playlistName?: (id: string) => string): string | null {
  if (!look.base && !look.overlays.length) return null
  return [...(look.base ? [look.base] : []), ...look.overlays].map((r) => describeThumbRule(r, playlistName)).join(' + ')
}

/** Problems that make a thumbnail rule unsaveable (conditions and shape; the style is checked by the plugin). */
export function validateThumbRule(rule: Pick<ThumbnailRule, 'conditions' | 'origin' | 'sample' | 'style' | 'overlay'>, surahs: SurahDict = DEFAULT_SURAHS): string[] {
  const errors: string[] = []
  if (rule.origin === 'default') {
    if (rule.conditions.length) errors.push('The default look has no conditions — it applies when no other rule matches')
    if (rule.overlay) errors.push('The default look cannot be an overlay')
  } else if (rule.conditions.length === 0) errors.push('Add at least one condition')
  errors.push(...conditionProblems(rule.conditions, surahs, thumbConditionKey))
  if (!rule.style || typeof rule.style !== 'object' || Array.isArray(rule.style)) errors.push('Style must be an object')
  if (!rule.sample || !Array.isArray(rule.sample.surahsAr) || rule.sample.surahsAr.length < 1 || rule.sample.surahsAr.length > 3) errors.push('The preview needs 1–3 surahs')
  if (rule.sample && !/^\d{4}-\d{2}-\d{2}$/.test(rule.sample.date)) errors.push('The preview date must be a real date')
  return errors
}

/** "Default look" / custom label / "Reciter is X · Playlist is Taraweeh 2025". */
export function describeThumbRule(rule: Pick<ThumbnailRule, 'conditions' | 'label' | 'origin'>, playlistName: (id: string) => string = (id) => id): string {
  if (rule.label?.trim()) return rule.label.trim()
  if (rule.origin === 'default') return 'Default look'
  return rule.conditions.map((c) => `${THUMB_KIND_LABEL[c.kind]} ${c.negate ? 'is not' : 'is'} ${c.kind === 'playlist' ? playlistName(c.value) : c.value || '…'}`).join(' · ')
}

/** Count of knobs a patch sets (leaf values). 0 = the plugin's default look. */
export function countKnobs(patch: unknown): number {
  if (!patch || typeof patch !== 'object') return 0
  let n = 0
  for (const v of Object.values(patch as Record<string, unknown>)) n += v !== null && typeof v === 'object' ? countKnobs(v) : 1
  return n
}
export const isEmptyPatch = (patch: unknown): boolean => countKnobs(patch) === 0

/** Drop knobs that equal their default and groups left empty, so a saved patch holds only real changes. */
export function prunePatch(patch: Record<string, unknown>, defaults: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) {
    const d = defaults[k]
    if (v !== null && typeof v === 'object' && d !== null && typeof d === 'object') {
      const sub = prunePatch(v as Record<string, unknown>, d as Record<string, unknown>)
      if (Object.keys(sub).length) out[k] = sub
    } else if (v !== undefined && v !== d) out[k] = v
  }
  return out
}

/** Read a dotted knob path from a (possibly partial) style object. */
export function getKnob(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const seg of path.split('.')) { if (!cur || typeof cur !== 'object') return undefined; cur = (cur as Record<string, unknown>)[seg] }
  return cur
}
/** Return a copy of `patch` with the dotted knob set (or removed when value is undefined). */
export function setKnob(patch: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const segs = path.split('.')
  const out: Record<string, unknown> = { ...patch }
  let cur = out
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i]!
    cur[s] = { ...((cur[s] as Record<string, unknown> | undefined) ?? {}) }
    cur = cur[s] as Record<string, unknown>
  }
  const last = segs[segs.length - 1]!
  if (value === undefined) delete cur[last]; else cur[last] = value
  return out
}

export const todayIso = (d = new Date()): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export function defaultSample(folder = ''): ThumbnailSample { return { folder, surahsAr: ['الفاتحة'], prayer: 'Isha', date: todayIso() } }

export function defaultThumbnailRule(folder = ''): ThumbnailRule {
  return { id: DEFAULT_RULE_ID, origin: 'default', enabled: true, conditions: [], style: {}, sample: defaultSample(folder) }
}

export function newThumbnailRule(conditions: ThumbCondition[], sample: ThumbnailSample): ThumbnailRule {
  return { id: crypto.randomUUID(), enabled: true, conditions, style: {}, sample }
}

/** Exactly one default rule, always present, always last (so list order of the others is the priority). */
export function normaliseThumbRules(rules: readonly ThumbnailRule[]): ThumbnailRule[] {
  const others = rules.filter((r) => r.origin !== 'default')
  const def = rules.find((r) => r.origin === 'default') ?? defaultThumbnailRule()
  return [...others.map((r) => (r.overlay && r.photo ? { ...r, photo: undefined } : r)), { ...def, id: DEFAULT_RULE_ID, conditions: [], overlay: false, photo: undefined }]
}
