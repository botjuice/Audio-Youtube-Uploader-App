import { clsx } from 'clsx'
import { AlertTriangle, ArrowDown, ArrowUp, ChevronDown, ChevronRight, Image as ImageIcon, Maximize2, Plus, RotateCcw, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { StyleFieldInfo, StylePatch, StyleSchemaInfo, SurahOption, ThumbCondition, ThumbConditionKind, ThumbnailPreview, ThumbnailRule, ThumbnailSample } from '@shared/types'
import { PRAYERS } from '@core/prayers'
import { DEFAULT_SURAHS } from '@core/surahs'
import { MAX_CONDITIONS } from '@core/rules'
import { THUMB_KIND_LABEL, countKnobs, defaultSample, describeThumbRule, getKnob, newThumbnailRule, prunePatch, resolveThumbnailRule, setKnob, validateThumbRule } from '@core/thumb-rules'
import { Badge, Button, ColorInput, Empty, IconButton, Input, Select, Slider, Spinner, Switch } from '@/components/ui'
import { errText, useStore } from '@/store'

const SURAH_KEYS = Object.keys(DEFAULT_SURAHS).sort()
const KINDS = Object.keys(THUMB_KIND_LABEL) as ThumbConditionKind[]
const GROUP_TITLES: Record<string, string> = {
  photo: 'Photo', overlay: 'Overlay & shading', text: 'Text layout', shadow: 'Text shadow', title: 'Surah title',
  reciter: 'Reciter line', meta: 'Prayer · date line', dividers: 'Dividers', frame: 'Border frame', output: 'Output',
}
const humanise = (seg: string) => seg.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())

type Draft = { rule: ThumbnailRule; isNew: boolean }

// ── Shared preview hook: debounced, out-of-order safe, memoised across cards ─────────────────────

const previewCache = new Map<string, ThumbnailPreview>()
function useStyledPreview(sample: ThumbnailSample, style: StylePatch, enabled = true, delay = 250) {
  const sheikh = useStore((s) => s.settings?.thumbnails.sheikhPrefix ?? true)
  const key = JSON.stringify([sample, style, sheikh])
  const [result, setResult] = useState<ThumbnailPreview | null>(() => previewCache.get(key) ?? null)
  const [rendering, setRendering] = useState(false)
  const seq = useRef(0)
  useEffect(() => {
    if (!enabled) return
    const hit = previewCache.get(key)
    if (hit) { setResult(hit); setRendering(false); return }
    const mine = ++seq.current
    setRendering(true)
    const t = setTimeout(async () => {
      let r: ThumbnailPreview
      try { r = await window.api.renderStyled({ sample, style, sheikhPrefix: sheikh }) }
      catch (e) { r = { ok: false, reason: 'RENDER_FAILED', message: errText(e) } }
      if (r.ok) previewCache.set(key, r)
      if (mine === seq.current) { setResult(r); setRendering(false) }
    }, delay)
    return () => clearTimeout(t)
  }, [key, enabled])  // eslint-disable-line react-hooks/exhaustive-deps
  return { result, rendering }
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ThumbnailRules() {
  const library = useStore((s) => s.library)
  const settings = useStore((s) => s.settings)
  const call = useStore((s) => s.call)
  const [draft, setDraft] = useState<Draft | null>(null)
  const rules = library.thumbnailRules
  const firstFolder = library.reciters[0]?.folder ?? ''

  const persist = (next: ThumbnailRule[]) => call('thumbRules', () => window.api.setThumbnailRules(next), { success: 'Thumbnail rules saved' })
  const plName = (id: string) => library.playlists.find((p) => p.id === id)?.title ?? `(unknown playlist ${id.slice(0, 8)}…)`

  // which rule each recording would get (first match wins) → counts per rule
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of library.records) {
      const hit = resolveThumbnailRule({ reciter: r.reciterKey, tokens: r.tokens, playlists: r.playlists.final }, rules)
      if (hit) m.set(hit.id, (m.get(hit.id) ?? 0) + 1)
    }
    return m
  }, [library.records, rules])

  const others = rules.filter((r) => r.origin !== 'default')
  const def = rules.find((r) => r.origin === 'default')

  const move = (id: string, dir: -1 | 1) => {
    const i = others.findIndex((r) => r.id === id); const j = i + dir
    if (i < 0 || j < 0 || j >= others.length) return
    const next = [...others]; const [a] = next.splice(i, 1); next.splice(j, 0, a!)
    void persist([...next, ...(def ? [def] : [])])
  }
  const startNew = () => {
    const sample = defaultSample(firstFolder)
    setDraft({ rule: newThumbnailRule([{ kind: 'reciter', value: firstFolder, negate: false }], sample), isNew: true })
  }
  const saveDraft = async (rule: ThumbnailRule) => {
    const exists = rules.some((r) => r.id === rule.id)
    const next = exists ? rules.map((r) => (r.id === rule.id ? rule : r)) : [...others, rule, ...(def ? [def] : [])]
    const ok = await persist(next)
    if (ok !== undefined) setDraft(null)
  }

  return (
    <div className="h-full overflow-auto">
      <div className="drag h-13 flex items-center gap-3 px-6 border-b border-border">
        <h1 className="font-semibold">Thumbnail rules</h1>
        <span className="text-xs text-muted">Each recording gets the look of the first rule it matches, top to bottom; otherwise the default look.</span>
        {settings && !settings.thumbnails.enabled && <Badge tone="warn">Thumbnails are off in Settings — uploads use the plain photo</Badge>}
        <Button variant="primary" size="sm" className="ml-auto no-drag" onClick={startNew} disabled={!library.reciters.length}><Plus size={14} /> New rule</Button>
      </div>

      {!library.reciters.length ? (
        <Empty icon={<ImageIcon size={28} />} title="No reciter folders yet" hint="Thumbnail previews need a reciter photo and Arabic name. Add a reciter folder first." />
      ) : (
        <div className="p-6 grid gap-5 grid-cols-[repeat(auto-fill,minmax(320px,1fr))] max-w-[1600px]">
          {others.map((rule, i) => (
            <RuleCard key={rule.id} rule={rule} count={counts.get(rule.id) ?? 0} plName={plName} index={i} total={others.length}
              onEdit={() => setDraft({ rule, isNew: false })}
              onToggle={(enabled) => void persist(rules.map((r) => (r.id === rule.id ? { ...r, enabled } : r)))}
              onMove={(d) => move(rule.id, d)}
              onDelete={() => void persist(rules.filter((r) => r.id !== rule.id))} />
          ))}
          {def && <RuleCard rule={def} count={counts.get(def.id) ?? 0} plName={plName} index={0} total={1} onEdit={() => setDraft({ rule: def, isNew: false })} />}
        </div>
      )}

      {draft && (
        <RuleEditorModal key={draft.rule.id} draft={draft} plName={plName} rules={rules}
          onSave={saveDraft} onDiscard={() => setDraft(null)} />
      )}
    </div>
  )
}

// ── Card ──────────────────────────────────────────────────────────────────────

function RuleCard({ rule, count, plName, index, total, onEdit, onToggle, onMove, onDelete }: {
  rule: ThumbnailRule; count: number; plName: (id: string) => string; index: number; total: number
  onEdit: () => void; onToggle?: (v: boolean) => void; onMove?: (d: -1 | 1) => void; onDelete?: () => void
}) {
  const { result, rendering } = useStyledPreview(rule.sample, rule.style)
  const isDefault = rule.origin === 'default'
  const knobs = countKnobs(rule.style)
  return (
    <section className={clsx('rounded-xl border border-border bg-surface shadow-xs overflow-hidden flex flex-col', !rule.enabled && !isDefault && 'opacity-60')}>
      <button type="button" onClick={onEdit} title="Click to edit this look" className="group relative block w-full aspect-video bg-surface-2 text-left no-drag">
        {result?.ok ? <img src={result.dataUrl} alt="" className="h-full w-full object-cover" />
          : result ? <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 p-4 text-center text-xs text-warn"><AlertTriangle size={18} /><span>{result.reason}</span><span className="text-muted">{result.message}</span></div>
          : <div className="absolute inset-0 flex items-center justify-center text-muted"><ImageIcon size={26} /></div>}
        {rendering && <span className="absolute top-2 right-2"><Spinner className="text-white drop-shadow" /></span>}
        <span className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 transition-opacity group-hover:opacity-100">
          <span className="inline-flex items-center gap-2 rounded-lg bg-white/95 px-3 py-1.5 text-[13px] font-medium text-slate-900 shadow"><Maximize2 size={14} /> Edit look</span>
        </span>
      </button>
      <div className="p-3 space-y-2">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate text-[13px] font-medium" title={describeThumbRule({ ...rule, label: undefined }, plName)}>{describeThumbRule(rule, plName)}</div>
          {isDefault ? <Badge tone="accent">default</Badge> : onToggle && <Switch checked={rule.enabled} onChange={onToggle} label="Enabled" />}
        </div>
        <div className="flex flex-wrap gap-1">
          {isDefault ? <span className="text-xs text-muted">Applies when no other rule matches.</span>
            : rule.conditions.map((c, i) => (
              <Badge key={i} tone={c.negate ? 'warn' : 'info'}>{THUMB_KIND_LABEL[c.kind]} {c.negate ? 'is not' : 'is'} {c.kind === 'playlist' ? plName(c.value) : c.value || '…'}</Badge>
            ))}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted">
          <span>{knobs ? `${knobs} knob${knobs === 1 ? '' : 's'} changed` : 'plugin default look'}</span>
          <span>·</span>
          <span className="tabular-nums">{count} recording{count === 1 ? '' : 's'} now</span>
          {!isDefault && (
            <span className="ml-auto inline-flex items-center gap-0.5">
              <IconButton label="Higher priority" className="h-7 w-7" disabled={index === 0} onClick={() => onMove?.(-1)}><ArrowUp size={13} /></IconButton>
              <IconButton label="Lower priority" className="h-7 w-7" disabled={index >= total - 1} onClick={() => onMove?.(1)}><ArrowDown size={13} /></IconButton>
              <IconButton label="Delete rule" className="h-7 w-7" onClick={onDelete}><Trash2 size={13} /></IconButton>
            </span>
          )}
        </div>
      </div>
    </section>
  )
}

// ── Maximised editor: closes only via Discard or Save ─────────────────────────

function RuleEditorModal({ draft, rules, plName, onSave, onDiscard }: {
  draft: Draft; rules: ThumbnailRule[]; plName: (id: string) => string; onSave: (rule: ThumbnailRule) => Promise<void>; onDiscard: () => void
}) {
  const library = useStore((s) => s.library)
  const saving = useStore((s) => !!s.busy['thumbRules'])
  const [rule, setRule] = useState<ThumbnailRule>(draft.rule)
  const [schema, setSchema] = useState<StyleSchemaInfo | null>(null)
  const [surahOptions, setSurahOptions] = useState<SurahOption[]>([])
  const [full, setFull] = useState(false)
  useEffect(() => { void window.api.getStyleSchema().then(setSchema); void window.api.listSurahOptions().then(setSurahOptions) }, [])

  const isDefault = rule.origin === 'default'
  const errors = validateThumbRule(rule)
  const { result, rendering } = useStyledPreview(rule.sample, rule.style)
  const styleBlocks = !!result && !result.ok && (result.reason === 'INVALID_STYLE' || result.reason === 'TEXT_OVERFLOW')
  const canSave = errors.length === 0 && !styleBlocks && !rendering && !saving
  const knobs = countKnobs(rule.style)
  const matches = useMemo(() => library.records.filter((r) => resolveThumbnailRule({ reciter: r.reciterKey, tokens: r.tokens, playlists: r.playlists.final },
    rules.some((x) => x.id === rule.id) ? rules.map((x) => (x.id === rule.id ? rule : x)) : [...rules.filter((x) => x.origin !== 'default'), rule, ...rules.filter((x) => x.origin === 'default')])?.id === rule.id).length, [library.records, rules, rule])

  const patchStyle = (path: string, value: unknown) => {
    if (!schema) return
    const def = getKnob(schema.defaults, path)
    const next = setKnob(rule.style as Record<string, unknown>, path, value === def ? undefined : value)
    setRule({ ...rule, style: prunePatch(next, schema.defaults as unknown as Record<string, unknown>) as StylePatch })
  }
  const resetGroup = (group: string) => { const next = { ...(rule.style as Record<string, unknown>) }; delete next[group]; setRule({ ...rule, style: next as StylePatch }) }
  const setSample = (p: Partial<ThumbnailSample>) => setRule({ ...rule, sample: { ...rule.sample, ...p } })
  const setCond = (i: number, c: Partial<ThumbCondition>) => setRule({ ...rule, conditions: rule.conditions.map((x, j) => (j === i ? { ...x, ...c } : x)) })

  const groups = useMemo(() => {
    const m = new Map<string, StyleFieldInfo[]>()
    for (const f of schema?.fields ?? []) { const g = f.path.split('.')[0]!; (m.get(g) ?? m.set(g, []).get(g)!).push(f) }
    return [...m.entries()]
  }, [schema])

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px] no-drag" role="dialog" aria-modal="true">
      <div className="absolute inset-3 flex flex-col overflow-hidden rounded-xl border border-border bg-bg shadow-2xl">
        <header className="flex items-center gap-3 border-b border-border px-4 py-2.5">
          <ImageIcon size={16} className="text-accent" />
          <Input value={rule.label ?? ''} onChange={(e) => setRule({ ...rule, label: e.target.value || undefined })} placeholder={describeThumbRule({ ...rule, label: undefined }, plName)} className="h-8 max-w-md text-[13px]" />
          {isDefault && <Badge tone="accent">default look</Badge>}
          {draft.isNew && <Badge>new rule</Badge>}
          <Badge tone={knobs ? 'info' : 'muted'}>{knobs ? `${knobs} knob${knobs === 1 ? '' : 's'} changed` : 'plugin defaults'}</Badge>
          <span className="text-xs text-muted tabular-nums">{matches} recording{matches === 1 ? '' : 's'} would get this look</span>
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="ghost" disabled={!knobs} onClick={() => setRule({ ...rule, style: {} })}><RotateCcw size={13} /> Reset all knobs</Button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          {/* left: conditions, sample, knobs */}
          <aside className="w-[400px] shrink-0 overflow-y-auto border-r border-border">
            <Section title="When" hint={isDefault ? 'The default look has no conditions — it applies when no other rule matches.' : 'All conditions must be true. The first matching rule in the list wins.'}>
              {!isDefault && (
                <div className="space-y-1.5">
                  {rule.conditions.map((c, i) => (
                    <div key={i} className="grid grid-cols-[36px_72px_96px_minmax(0,1fr)_26px] items-center gap-1.5">
                      <span className="text-[11px] text-muted text-right">{i === 0 ? 'when' : 'and'}</span>
                      <Select value={c.negate ? 'not' : 'is'} onChange={(e) => setCond(i, { negate: e.target.value === 'not' })} className="h-7.5 text-xs"><option value="is">is</option><option value="not">is not</option></Select>
                      <Select value={c.kind} onChange={(e) => setCond(i, { kind: e.target.value as ThumbConditionKind, value: '' })} className="h-7.5 text-xs">{KINDS.map((k) => <option key={k} value={k}>{THUMB_KIND_LABEL[k]}</option>)}</Select>
                      <CondValue c={c} onChange={(value) => setCond(i, { value })} />
                      <IconButton label="Remove condition" className="h-7 w-7" disabled={rule.conditions.length === 1} onClick={() => setRule({ ...rule, conditions: rule.conditions.filter((_, j) => j !== i) })}><X size={12} /></IconButton>
                    </div>
                  ))}
                  {rule.conditions.length < MAX_CONDITIONS && (
                    <button className="text-[11px] text-accent hover:underline" onClick={() => setRule({ ...rule, conditions: [...rule.conditions, { kind: 'prayer', value: PRAYERS[0]!, negate: false }] })}>+ add condition ({MAX_CONDITIONS - rule.conditions.length} left)</button>
                  )}
                  {errors[0] && <div className="text-[11px] text-err">{errors[0]}</div>}
                </div>
              )}
            </Section>

            <Section title="Preview sample" hint="Saved with the rule. Photo and Arabic name come from the reciter folder, exactly as in an upload.">
              <div className="space-y-2">
                <Select value={rule.sample.folder} onChange={(e) => setSample({ folder: e.target.value })} className="h-7.5 w-full text-xs">
                  {!library.reciters.some((r) => r.folder === rule.sample.folder) && <option value={rule.sample.folder}>{rule.sample.folder ? `⚠ ${rule.sample.folder} (not found)` : '(first reciter)'}</option>}
                  {library.reciters.map((r) => <option key={r.folder} value={r.folder}>{r.folder}{r.nameAr ? ` · ${r.nameAr}` : ' · ⚠ no Arabic name'}</option>)}
                </Select>
                {rule.sample.surahsAr.map((s, i) => (
                  <div key={i} className="flex gap-1.5">
                    <Select value={s} onChange={(e) => setSample({ surahsAr: rule.sample.surahsAr.map((x, j) => (j === i ? e.target.value : x)) })} className="h-7.5 flex-1 text-xs">
                      {!surahOptions.some((o) => o.ar === s) && <option value={s}>{s}</option>}
                      {surahOptions.map((o) => <option key={o.n} value={o.ar}>{o.n}. {o.ar}{o.label ? ` — ${o.label}` : ''}</option>)}
                    </Select>
                    <IconButton label="Remove surah" className="h-7 w-7" disabled={rule.sample.surahsAr.length === 1} onClick={() => setSample({ surahsAr: rule.sample.surahsAr.filter((_, j) => j !== i) })}><X size={12} /></IconButton>
                  </div>
                ))}
                <div className="grid grid-cols-[1fr_1fr_auto] gap-1.5">
                  <Select value={rule.sample.prayer} onChange={(e) => setSample({ prayer: e.target.value })} className="h-7.5 text-xs">{PRAYERS.map((p) => <option key={p} value={p}>{p}</option>)}</Select>
                  <input type="date" value={rule.sample.date} onChange={(e) => setSample({ date: e.target.value })} className="h-7.5 rounded-lg border border-border bg-surface px-2 text-xs no-drag" />
                  {rule.sample.surahsAr.length < 3 && <Button size="sm" variant="subtle" onClick={() => setSample({ surahsAr: [...rule.sample.surahsAr, surahOptions[0]?.ar ?? 'الفاتحة'] })}><Plus size={12} /> surah</Button>}
                </div>
              </div>
            </Section>

            {!schema ? <div className="p-4 text-xs text-muted">Loading knobs…</div> : groups.map(([group, fields]) => (
              <KnobGroup key={group} group={group} fields={fields} style={rule.style} schema={schema} errors={result && !result.ok ? result.styleErrors ?? [] : []}
                onChange={patchStyle} onReset={() => resetGroup(group)} />
            ))}
          </aside>

          {/* right: big preview */}
          <main className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
            <div className="flex items-center gap-2 text-xs text-muted">
              {rendering ? <><Spinner className="text-accent" /> Rendering…</> : result?.ok ? <>{result.cached ? 'From cache' : 'Rendered'}{result.ms !== undefined ? ` in ${result.ms} ms` : ''} · 1920×1080 frame; the YouTube thumbnail is the same at 1280×720</> : 'Change anything on the left — the frame updates by itself'}
              {result?.ok && <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setFull(true)}><Maximize2 size={13} /> Full size</Button>}
            </div>
            {result?.ok ? (
              <button type="button" className="block w-full overflow-hidden rounded-lg border border-border bg-black" onClick={() => setFull(true)} title="Click to view full size">
                <img src={result.frameDataUrl ?? result.dataUrl} alt="frame" className="aspect-video w-full object-contain" />
              </button>
            ) : result ? (
              <div className="rounded-lg border border-warn/30 bg-warn/6 p-3 text-sm">
                <div className="font-medium">Can't render ({result.reason})</div>
                <div className="mt-1 whitespace-pre-line text-xs text-muted">{result.message}</div>
                {styleBlocks && <div className="mt-2 text-xs text-err">Fix this before saving — the plugin would refuse it on upload and the plain photo would be used.</div>}
              </div>
            ) : <div className="flex aspect-video w-full items-center justify-center rounded-lg bg-surface-2 text-muted"><ImageIcon size={28} /></div>}
            {result?.ok && result.warnings && result.warnings.length > 0 && (
              <ul className="space-y-1 rounded-lg border border-warn/30 bg-warn/6 p-3 text-xs">
                {result.warnings.map((w, i) => <li key={i} className="flex gap-1.5"><AlertTriangle size={12} className="mt-0.5 shrink-0 text-warn" /> {w}</li>)}
              </ul>
            )}
          </main>
        </div>

        <footer className="flex items-center gap-3 border-t border-border px-4 py-2.5">
          <span className="text-xs text-muted">{draft.isNew ? 'Discard removes this new rule.' : 'Discard returns to the saved version.'} Changes apply to future uploads; pending videos re-render with the new look.</span>
          <div className="ml-auto flex gap-2">
            <Button onClick={onDiscard} disabled={saving}>Discard</Button>
            <Button variant="primary" disabled={!canSave} onClick={() => void onSave(rule)} title={errors[0] ?? (styleBlocks ? 'The style cannot render' : undefined)}>{saving ? <Spinner /> : null} Save</Button>
          </div>
        </footer>
      </div>
      {full && result?.ok && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/85 p-6" onClick={() => setFull(false)}>
          <img src={result.frameDataUrl ?? result.dataUrl} alt="frame" className="max-h-full max-w-full rounded-lg shadow-2xl" />
        </div>
      )}
      <datalist id="thumb-surah-keys">{SURAH_KEYS.map((k) => <option key={k} value={k} />)}</datalist>
    </div>
  )
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-border px-4 py-3">
      <div className="text-[12.5px] font-semibold">{title}</div>
      {hint && <div className="mb-2 text-[11px] text-muted">{hint}</div>}
      {children}
    </section>
  )
}

function CondValue({ c, onChange }: { c: ThumbCondition; onChange: (v: string) => void }) {
  const library = useStore((s) => s.library)
  const cls = 'h-7.5 text-xs w-full'
  switch (c.kind) {
    case 'reciter':
      return <Select value={c.value} onChange={(e) => onChange(e.target.value)} className={cls}><option value="">choose reciter…</option>{library.reciters.map((r) => <option key={r.folder} value={r.folder}>{r.folder}</option>)}{c.value && !library.reciters.some((r) => r.folder === c.value) && <option value={c.value}>⚠ {c.value} (folder not found)</option>}</Select>
    case 'prayer':
      return <Select value={c.value} onChange={(e) => onChange(e.target.value)} className={cls}><option value="">choose prayer…</option>{PRAYERS.map((p) => <option key={p} value={p}>{p}</option>)}</Select>
    case 'surah':
      return <Input list="thumb-surah-keys" value={c.value} onChange={(e) => onChange(e.target.value)} placeholder="e.g. baqarah" className={cls} />
    case 'keyword':
      return <Select value={c.value} onChange={(e) => onChange(e.target.value)} className={cls}><option value="">{library.keywords.length ? 'choose keyword…' : 'no keywords registered'}</option>{library.keywords.map((k) => <option key={k.name} value={k.name}>{k.name}</option>)}</Select>
    case 'playlist':
      return <Select value={c.value} onChange={(e) => onChange(e.target.value)} className={cls}><option value="">{library.playlists.length ? 'choose playlist…' : 'no playlists loaded — refresh in Playlists'}</option>{library.playlists.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}{c.value && !library.playlists.some((p) => p.id === c.value) && <option value={c.value}>⚠ unknown playlist</option>}</Select>
  }
}

// ── Knob groups built from the plugin schema ──────────────────────────────────

function KnobGroup({ group, fields, style, schema, errors, onChange, onReset }: {
  group: string; fields: StyleFieldInfo[]; style: StylePatch; schema: StyleSchemaInfo; errors: { key: string; message: string }[]
  onChange: (path: string, value: unknown) => void; onReset: () => void
}) {
  const changed = countKnobs((style as Record<string, unknown>)[group])
  const [open, setOpen] = useState(changed > 0)
  const direct = fields.filter((f) => f.path.split('.').length === 2)
  const subs = new Map<string, StyleFieldInfo[]>()
  for (const f of fields) if (f.path.split('.').length > 2) { const s = f.path.split('.')[1]!; (subs.get(s) ?? subs.set(s, []).get(s)!).push(f) }
  return (
    <section className="border-b border-border">
      <div className="flex items-center gap-2 px-4 py-2">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[12.5px] font-semibold no-drag" onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={13} className="text-muted" /> : <ChevronRight size={13} className="text-muted" />}
          {GROUP_TITLES[group] ?? humanise(group)}
          {changed > 0 && <Badge tone="info">{changed}</Badge>}
        </button>
        {changed > 0 && <IconButton label="Reset this group" className="h-6 w-6" onClick={onReset}><RotateCcw size={12} /></IconButton>}
      </div>
      {open && (
        <div className="space-y-2 px-4 pb-3">
          {direct.map((f) => <Knob key={f.path} info={f} style={style} schema={schema} error={errors.find((e) => e.key === f.path)?.message} onChange={onChange} />)}
          {[...subs.entries()].map(([sub, list]) => (
            <div key={sub} className="rounded-lg border border-border/70 bg-surface-2/40 p-2 space-y-2">
              <div className="text-[11px] font-medium text-muted">{humanise(sub)}</div>
              {list.map((f) => <Knob key={f.path} info={f} style={style} schema={schema} error={errors.find((e) => e.key === f.path)?.message} onChange={onChange} />)}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function Knob({ info, style, schema, error, onChange }: { info: StyleFieldInfo; style: StylePatch; schema: StyleSchemaInfo; error?: string; onChange: (path: string, value: unknown) => void }) {
  const { path, field } = info
  const def = getKnob(schema.defaults, path)
  const current = getKnob(style, path)
  const value = current ?? def
  const changed = current !== undefined
  const label = humanise(path.split('.').pop()!)
  const decimals = field.kind === 'number' ? Math.max(0, -Math.floor(Math.log10(field.step))) : 0
  return (
    <div className={clsx('grid gap-x-2 gap-y-1', field.kind === 'number' ? 'grid-cols-[minmax(0,1fr)_64px_20px]' : 'grid-cols-[minmax(0,1fr)_auto_20px]')} title={field.desc}>
      <div className="flex items-center gap-1.5 text-[12px]"><span className={clsx(changed && 'font-medium text-accent')}>{label}</span><span className="truncate text-[10.5px] text-muted">{field.desc}</span></div>
      {field.kind === 'number' ? (
        <input type="number" value={Number(value).toFixed(decimals)} min={field.min} max={field.max} step={field.step}
          onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) onChange(path, Math.min(field.max, Math.max(field.min, n))) }}
          className="h-6 w-full rounded-md border border-border bg-surface px-1.5 text-right text-[11px] tabular-nums no-drag focus:outline-none focus:ring-2 focus:ring-accent/40" />
      ) : <ColorInput value={String(value)} onChange={(v) => onChange(path, v)} />}
      <button type="button" title={`Reset to ${String(def)}`} disabled={!changed} onClick={() => onChange(path, def)} className={clsx('flex h-6 w-5 items-center justify-center rounded text-muted hover:text-text no-drag', !changed && 'invisible')}><RotateCcw size={11} /></button>
      {field.kind === 'number' && <Slider value={Number(value)} min={field.min} max={field.max} step={field.step} onChange={(v) => onChange(path, Number(v.toFixed(decimals)))} className="col-span-3" />}
      {error && <div className="col-span-3 text-[11px] text-err">{error}</div>}
    </div>
  )
}
