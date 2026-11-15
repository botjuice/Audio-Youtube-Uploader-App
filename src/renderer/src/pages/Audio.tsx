import { clsx } from 'clsx'
import { AlertTriangle, ArrowLeft, AudioLines, ChevronsRight, Download, Keyboard, Pause, Play, Repeat, RotateCcw, Save, Trash2, Undo2, Upload, WandSparkles, Waves, X } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AudioAnalysis, AudioLook, AudioOverview } from '@shared/types'
import { EQ_BANDS, KNOBS, MODULE_ORDER, MODULE_TITLES, SIGNAL_FLOW, countOn, defaultModules, toLook, type EqState, type Knob, type ModuleKey, type Modules, type StripKey } from '@core/audio-modules'
import { MAX_REFERENCES, type AudioRule } from '@core/audio-rules'
import type { ReportRow, SuggestNote } from '@core/audio-suggest'
import { eqResponseDb, logFrequencies } from '@core/eq-response'
import { describeLook, validateLook } from '../../../plugins/audio/look'
import { Badge, Button, IconButton, Select, Slider, Spinner, Switch, Empty } from '@/components/ui'
import { MEASURE_BANDS } from '../../../plugins/audio/types'
import { errText, useStore } from '@/store'

const audioUrl = (file: string) => `yj-audio://preview/?p=${encodeURIComponent(file)}`

// ── helpers ───────────────────────────────────────────────────────────────────

const fmtTime = (s: number) => { const m = Math.floor(s / 60), r = Math.floor(s - m * 60); return `${m}:${String(r).padStart(2, '0')}` }
const fmtNum = (v: number, step: number) => v.toFixed(Math.min(4, (String(step).split('.')[1] ?? '').length))
const db = (v: number, unit = 'dB') => { const x = Math.abs(v) < 0.05 ? 0 : v; return `${x > 0 ? '+' : ''}${x.toFixed(1)} ${unit}` }   // never "-0.0"

// Log sliders move in 1000 steps between min and max; linear ones use the knob's own range.
const SLIDER_STEPS = 1000
const toPos = (k: { min: number; max: number; log?: boolean }, v: number) => k.log ? Math.round(((Math.log(Math.max(k.min, v)) - Math.log(k.min)) / (Math.log(k.max) - Math.log(k.min))) * SLIDER_STEPS) : v
const fromPos = (k: { min: number; max: number; step: number; log?: boolean }, p: number) => {
  if (!k.log) return p
  const raw = Math.exp(Math.log(k.min) + (p / SLIDER_STEPS) * (Math.log(k.max) - Math.log(k.min)))
  return Math.min(k.max, Math.max(k.min, Math.round(raw / k.step) * k.step))
}

// ── page ──────────────────────────────────────────────────────────────────────

const DEFAULT_RULE = '\u0000default'
/** A recording's name for a chip or a card: no extension, and without the reciter's name it starts with. */
const shortName = (fileName: string, folder: string) => {
  const base = fileName.replace(/\.[^.]+$/, '')
  return folder && base.toLowerCase().startsWith(folder.toLowerCase()) && base.length > folder.length ? base.slice(folder.length).replace(/^[-_ ]+/, '') : base
}
/** Reasons that read the same for several modules are shown once, with the modules named together. */
function groupNotes(notes: SuggestNote[]): { modules: string; text: string }[] {
  const out: { keys: string[]; text: string }[] = []
  for (const n of notes) {
    const same = out.find((g) => g.text === n.text)
    if (same) same.keys.push(MODULE_TITLES[n.module]); else out.push({ keys: [MODULE_TITLES[n.module]], text: n.text })
  }
  return out.map((g) => ({ modules: g.keys.join(', '), text: g.text }))
}
const newRuleId = () => `rule-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** The Audio rules tab: the library of rules first; a rule opens in the editor. */
export default function AudioPage() {
  const [editing, setEditing] = useState<string | null>(null)
  return editing === null ? <RulesLibrary onOpen={setEditing} /> : <RuleEditor key={editing} initialKey={editing} onBack={() => setEditing(null)} />
}

/** A target's tone as a small curve (level per band, low to high), so rules can be told apart at a glance. */
function ToneCurve({ tone }: { tone: number[] }) {
  const pts = tone.map((v, b) => ({ f: MEASURE_BANDS[b]!, v })).filter((p) => p.f >= 100 && p.f <= 10000)
  if (pts.length < 2) return null
  const top = Math.max(...pts.map((p) => p.v)), bottom = top - 40
  const x = (f: number) => (Math.log(f / 100) / Math.log(100)) * 300, y = (v: number) => 8 + ((top - Math.max(bottom, v)) / (top - bottom)) * 84
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.f).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ')
  return (
    <svg viewBox="0 0 300 100" preserveAspectRatio="none" className="h-full w-full">
      {[1000].map((f) => <line key={f} x1={x(f)} x2={x(f)} y1="0" y2="100" stroke="currentColor" strokeOpacity="0.12" />)}
      <path d={`${line} L300,100 L0,100 Z`} fill="currentColor" fillOpacity="0.10" />
      <path d={line} fill="none" stroke="currentColor" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function RulesLibrary({ onOpen }: { onOpen: (ruleKey: string) => void }) {
  const library = useStore((s) => s.library)
  const notify = useStore((s) => s.notify)
  const call = useStore((s) => s.call)
  const state = library.audioRules
  const reciters = library.reciters
  const own = state.rules.filter((r) => r.reciterKey !== null)
  const def = state.rules.find((r) => r.reciterKey === null) ?? null
  const covered = new Set(own.filter((r) => r.target).map((r) => r.reciterKey))
  const countFor = (key: string | null) => library.records.filter((r) => (key === null ? !r.reciterKey || !covered.has(r.reciterKey) : r.reciterKey === key)).length
  const without = reciters.filter((r) => !own.some((x) => x.reciterKey === r.key))
  const folder = (key: string) => reciters.find((r) => r.key === key)?.folder ?? key
  const name = (id: string) => { const r = library.records.find((x) => x.id === id); return r ? shortName(r.fileName, r.reciterFolder) : `${id} (missing)` }

  const card = (key: string | null, rule: AudioRule | null) => {
    const target = rule?.target ?? null
    const builtIn = key === null && !rule ? library.audioBuiltIn : null
    const tone = target?.tone ?? builtIn?.tone
    const n = countFor(key)
    const applies = key !== null && !target ? 0 : n
    return (
      <section key={key ?? 'default'} className="flex flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-xs">
        <button type="button" onClick={() => onOpen(key ?? DEFAULT_RULE)} title="Click to open this rule" className="group relative block aspect-[3/1] w-full bg-surface-2 text-left text-accent no-drag">
          {tone ? <ToneCurve tone={tone} /> : <div className="absolute inset-0 flex items-center justify-center text-muted"><AudioLines size={26} /></div>}
          <span className="absolute bottom-1 left-2 text-[10.5px] text-muted">{tone ? 'target tone · 100 Hz' : 'no target yet'}</span>
          {tone && <span className="absolute bottom-1 right-2 text-[10.5px] text-muted">10 kHz</span>}
          <span className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 transition-opacity group-hover:opacity-100">
            <span className="inline-flex items-center gap-2 rounded-lg bg-white/95 px-3 py-1.5 text-[13px] font-medium text-slate-900 shadow"><AudioLines size={14} /> Open rule</span>
          </span>
        </button>
        <div className="space-y-2 p-3">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1 truncate text-[13px] font-medium">{key === null ? 'Default rule' : folder(key)}{rule?.label ? ` · ${rule.label}` : ''}</div>
            {key === null && <Badge tone="accent">{rule ? 'default' : 'default · built in'}</Badge>}
            {key !== null && !target && <Badge tone="warn">not saved yet</Badge>}
          </div>
          <div className="flex flex-wrap gap-1">
            {key === null ? <span className="text-xs text-muted">Applies to every reciter without a rule of their own.</span> : <Badge tone="info">Reciter is {folder(key)}</Badge>}
          </div>
          <div className="text-[11.5px] leading-snug text-muted">
            {target ? <>Mean of {target.count} reference recording{target.count === 1 ? '' : 's'}{rule && rule.refs.length ? `: ${rule.refs.map((r) => name(r.recordId)).join(', ')}` : ' (imported; the recordings are not in this library)'}. Loudness {target.lufs.toFixed(1)} LUFS{target.hp > 0 ? `, high-pass ${target.hp} Hz` : ''}. Captured {new Date(target.capturedAt).toLocaleDateString()}.</>
              : builtIn ? <>Comes with the app: the mean of {builtIn.count} recordings after the approved settings. Loudness {builtIn.lufs.toFixed(1)} LUFS, high-pass {builtIn.hp} Hz. Open it to make your own.</>
                : <>Has reference recordings but no target: open it and press Save rule.</>}
          </div>
          <div className="flex items-center gap-2 text-xs text-muted">
            <span className="tabular-nums">{applies} recording{applies === 1 ? '' : 's'} now</span>
            <span className="ml-auto inline-flex items-center gap-0.5">
              {rule?.target && <IconButton label="Export this rule" className="h-7 w-7" onClick={() => void call('audioExport', async () => { const r = await window.api.exportAudioRule(rule.id); if (r) notify('success', `Rule exported to ${r.path}`) })}><Download size={13} /></IconButton>}
              {rule && <IconButton label={key === null ? 'Remove your default rule (the built-in one applies again)' : 'Delete rule (the default rule applies to this reciter again)'} className="h-7 w-7" onClick={() => { if (window.confirm(key === null ? 'Remove your default rule? Its settings and target are discarded and the rule that comes with the app applies again.' : `Delete the rule for ${folder(key)}? Its settings and target are discarded and the default rule applies to this reciter again. Export it first if you may want it back.`)) void call('audioDelete', () => window.api.deleteAudioRule(rule.id)) }}><Trash2 size={13} /></IconButton>}
            </span>
          </div>
        </div>
      </section>
    )
  }

  return (
    <div className="h-full overflow-auto">
      <div className="drag flex h-13 items-center gap-3 border-b border-border px-6">
        <h1 className="shrink-0 whitespace-nowrap font-semibold">Audio rules</h1>
        <span className="min-w-0 truncate text-xs text-muted" title="Each recording is steered to its reciter’s rule; a reciter without one gets the default rule.">A reciter’s own rule wins · otherwise the default rule</span>
        {!state.applyToUploads && <span title="Recordings upload with their original audio until you switch this on."><Badge tone="warn" className="whitespace-nowrap">Off for uploads</Badge></span>}
        <div className="no-drag ml-auto flex shrink-0 items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted" title="When on, every upload first has its audio processed by its reciter’s rule (or the default rule). When off, recordings upload with their original audio.">
            <Switch checked={state.applyToUploads} onChange={(v) => void call('audioApply', () => window.api.setAudioApplyToUploads(v))} label="Use for uploads" /> Use for uploads
          </label>
          <Button size="sm" variant="ghost" onClick={() => void call('audioImport', async () => { const r = await window.api.importAudioRule(); if (r) notify('success', `Rule imported${r.reciterKey ? ` for ${r.reciterKey}` : ' as the default rule'}.`) })} title="Import a rule file. It becomes the rule for its reciter, replacing the one there."><Upload size={13} /> Import</Button>
          <Select value="" onChange={(e) => { if (e.target.value) onOpen(e.target.value) }} disabled={!without.length} className="h-8 max-w-[220px] text-[13px]" title={without.length ? 'Make a rule for a reciter' : 'Every reciter already has a rule'}>
            <option value="">+ New rule for…</option>
            {without.map((r) => <option key={r.key} value={r.key}>{r.folder}</option>)}
          </Select>
        </div>
      </div>
      {!library.records.length ? (
        <div className="p-6"><Empty icon={<AudioLines size={28} />} title="No recordings yet" hint="Add recordings to the library to make audio rules from them." /></div>
      ) : (
        <div className="grid max-w-[1600px] grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-5 p-6">
          {own.map((r) => card(r.reciterKey, r))}
          {card(null, def)}
        </div>
      )}
    </div>
  )
}

function RuleEditor({ initialKey, onBack }: { initialKey: string; onBack: () => void }) {
  const library = useStore((s) => s.library)
  const notify = useStore((s) => s.notify)
  const call = useStore((s) => s.call)
  const saving = useStore((s) => !!s.busy['audioRule'])
  const records = library.records
  const rulesState = library.audioRules
  const reciters = library.reciters

  // ── which rule ──
  const [ruleKey, setRuleKey] = useState<string>(initialKey)
  const reciterKey = ruleKey === DEFAULT_RULE ? null : ruleKey
  const stored = rulesState.rules.find((r) => r.reciterKey === reciterKey) ?? null
  const storedJson = JSON.stringify(stored)
  const blank = (): AudioRule => ({ id: newRuleId(), reciterKey, refs: [], target: null })
  const [draft, setDraft] = useState<AudioRule>(() => stored ?? blank())
  const [refIndex, setRefIndex] = useState(0)
  const [mode, setMode] = useState<'setup' | 'try'>('setup')
  const pool = useMemo(() => records.filter((r) => reciterKey === null || r.reciterKey === reciterKey), [records, reciterKey])
  const [tryId, setTryId] = useState('')
  const [tryModules, setTryModules] = useState<Modules>(() => defaultModules())
  const [start, setStart] = useState(60)
  const [analysis, setAnalysis] = useState<AudioAnalysis | null>(null)
  const [analysing, setAnalysing] = useState(false)
  // Auto-set / rule try-out: what it decided (with the reasons) and the settings from before, so one click undoes it
  const [auto, setAuto] = useState<{ how: string; report: ReportRow[] | null; findings: string[]; notes: SuggestNote[]; failed: { file: string; message: string }[]; before: Modules } | null>(null)
  const [autoBusy, setAutoBusy] = useState<{ done: number; total: number; stage?: string } | null>(null)
  const [saveStage, setSaveStage] = useState<string | null>(null)

  // the stored rule changed (saved, imported, deleted) or another rule was chosen: start again from what is stored
  useEffect(() => {
    setDraft(stored ? (JSON.parse(storedJson) as AudioRule) : blank())
    setRefIndex(0); setAuto(null)
  }, [ruleKey, storedJson])  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!pool.some((r) => r.id === tryId)) setTryId(pool[0]?.id ?? '') }, [pool, tryId])

  const ref = draft.refs[refIndex]
  const first = draft.refs[0]
  // a reference that follows the first one: ask what the first one's settings come to on this recording
  const followKey = mode === 'setup' && ref && !ref.modules && first?.modules ? JSON.stringify([first.recordId, ref.recordId, first.modules]) : null
  const [followed, setFollowed] = useState<{ key: string; modules: Modules; result: { how: string; report: ReportRow[] | null; findings: string[]; notes: SuggestNote[] } } | null>(null)
  useEffect(() => {
    if (!followKey || !first?.modules || !ref) return
    let live = true
    window.api.followAudioSettings(first.modules, first.recordId, ref.recordId)
      .then((r) => { if (live) setFollowed({ key: followKey, modules: r.modules, result: { how: r.how, report: r.report, findings: r.findings, notes: r.notes } }) })
      .catch((e) => { if (live) notify('error', errText(e)) })
    return () => { live = false }
  }, [followKey])  // eslint-disable-line react-hooks/exhaustive-deps
  const following = mode === 'setup' && !!ref && !ref.modules
  const followReady = following && followed?.key === followKey
  const modules: Modules = mode === 'try' ? tryModules : !ref ? defaultModules() : ref.modules ?? (followReady ? followed!.modules : defaultModules())
  const editable = mode === 'try' ? !!tryId : !!ref && (!following || followReady)
  const setModules = (next: Modules | ((m: Modules) => Modules)) => {
    if (!editable) return
    const value = typeof next === 'function' ? next(modules) : next
    if (mode === 'try') { setTryModules(value); return }
    // editing a reference that follows the first one gives it settings of its own
    setDraft((d) => ({ ...d, refs: d.refs.map((r, i) => (i === refIndex ? { ...r, modules: value } : r)) }))
  }

  const recordId = mode === 'try' ? tryId : ref?.recordId ?? ''
  const record = records.find((r) => r.id === recordId)
  useEffect(() => { setAnalysis(null); setAuto(null); setStart(60) }, [recordId, mode])

  const look: AudioLook = useMemo(() => toLook(modules), [modules])
  const validation = useMemo(() => validateLook(look), [look])
  const errors = validation.ok ? [] : validation.errors
  const on = countOn(modules)
  const strip = (key: StripKey) => modules[key] as Record<string, unknown> & { on: boolean }
  const update = <K extends ModuleKey>(key: K, patch: Partial<Modules[K]>) => setModules((m) => ({ ...m, [key]: { ...m[key], ...patch } }))

  const bare = (r: AudioRule | null) => (r ? JSON.stringify({ label: r.label ?? '', refs: r.refs }) : JSON.stringify({ label: '', refs: [] }))
  const dirty = bare(draft) !== bare(stored)
  const name = (id: string) => records.find((r) => r.id === id)?.fileName ?? `${id} (missing)`
  const short = (id: string) => { const r = records.find((x) => x.id === id); return r ? shortName(r.fileName, reciterKey === null ? '' : r.reciterFolder) : `${id} (missing)` }
  const reciterName = reciterKey === null ? 'every reciter without a rule of their own' : reciters.find((r) => r.key === reciterKey)?.folder ?? reciterKey

  const addRef = (id: string) => {
    if (!id || draft.refs.length >= MAX_REFERENCES) return
    setDraft((d) => ({ ...d, refs: [...d.refs, { recordId: id, modules: d.refs.length === 0 ? defaultModules() : null }] }))
    setRefIndex(draft.refs.length); setMode('setup')
  }
  const removeRef = (i: number) => {
    setDraft((d) => {
      const refs = d.refs.filter((_, k) => k !== i)
      // the first reference always has settings of its own: a follower promoted to first takes over the old first's
      if (i === 0 && refs[0] && !refs[0].modules) refs[0] = { ...refs[0], modules: d.refs[0]!.modules }
      return { ...d, refs }
    })
    setRefIndex((k) => Math.max(0, k >= i && k > 0 ? k - 1 : k))
  }
  const save = () => void call('audioRule', async () => {
    const off = window.api.on('audioMeasure', (p) => setSaveStage(p.stage ?? null))
    try {
      await window.api.saveAudioRule(draft)
      notify('success', draft.refs.length ? `Rule saved. Its target is the mean of ${draft.refs.length} reference recording${draft.refs.length === 1 ? '' : 's'} after their settings.` : 'Rule saved.')
    } finally { off(); setSaveStage(null) }
  })
  const analyse = () => {
    if (!record) return
    setAnalysing(true)
    window.api.analyseAudio(record.id).then(setAnalysis).catch((e) => notify('error', errText(e))).finally(() => setAnalysing(false))
  }
  /** Setting a rule up: Auto-set applies the default rule to this reference. Trying a rule out: what an upload would get
   *  (the default rule is tried as the default rule, whatever rule the recording's own reciter has). */
  const autoSet = () => {
    if (!record || autoBusy || !editable) return
    setAutoBusy({ done: 0, total: 0 })
    const off = window.api.on('audioMeasure', setAutoBusy)
    const before = modules
    window.api.suggestAudio(record.id, mode === 'try' ? defaultModules() : modules, mode === 'try' && reciterKey !== null ? 'upload' : 'default').then((r) => {
      setAuto((prev) => ({ how: r.how, report: r.report, findings: r.findings, notes: r.notes, failed: r.failed, before: prev?.before ?? before }))   // pressed twice: Undo still goes back to before the first
      setModules(r.modules)
    }).catch((e) => notify('error', errText(e))).finally(() => { off(); setAutoBusy(null) })
  }

  const target = stored?.target ?? null
  const status = dirty
    ? 'Unsaved changes. Saving processes the reference recordings, measures them and stores the mean as this rule’s target.'
    : target ? `Target captured ${new Date(target.capturedAt).toLocaleDateString()} from ${target.count} reference recording${target.count === 1 ? '' : 's'}${stored && stored.refs.length === 0 ? ' (imported; the recordings are not in this library)' : ''}. Every upload of ${reciterName} is steered to it.`
      : reciterKey === null
        ? (library.audioBuiltIn ? `No default rule of your own: the one that comes with the app applies (made from ${library.audioBuiltIn.count} recordings). Add reference recordings here to replace it.` : 'No default rule.')
        : `No rule for ${reciterName} yet, so the default rule applies to their recordings. Add a reference recording to make one.`

  return (
    <div className="flex h-full flex-col">
      <div className="drag h-13 flex shrink-0 items-center gap-3 border-b border-border px-6">
        <Button size="sm" variant="ghost" className="no-drag" onClick={() => { if (!dirty || window.confirm('Leave without saving this rule’s changes?')) onBack() }} title="Back to the list of audio rules"><ArrowLeft size={14} /> Audio rules</Button>
        <Select value={ruleKey} onChange={(e) => { if (!dirty || window.confirm('Switch rule without saving this one’s changes?')) setRuleKey(e.target.value) }} className="no-drag h-8 max-w-[260px] text-[13px]" title="Rules match by reciter. A reciter without a rule gets the default rule.">
          <option value={DEFAULT_RULE}>Default rule{rulesState.rules.some((r) => r.reciterKey === null) ? '' : ' (built in)'}</option>
          {reciters.map((r) => <option key={r.key} value={r.key}>{r.folder}{rulesState.rules.some((x) => x.reciterKey === r.key) ? '' : ' (no rule: default applies)'}</option>)}
        </Select>
        <div className="no-drag ml-auto flex shrink-0 items-center gap-2">
          <Button size="sm" variant="ghost" disabled={!stored?.target || dirty} onClick={() => void call('audioExport', async () => { const r = await window.api.exportAudioRule(stored!.id); if (r) notify('success', `Rule exported to ${r.path}`) })} title="Export this rule as a file. The target travels in the file, so it works on a computer without these recordings."><Download size={13} /> Export</Button>
          <Button size="sm" variant="ghost" disabled={!stored} onClick={() => { if (window.confirm('Delete this rule? Its settings and target are discarded. Export it first if you may want it back.')) void call('audioDelete', async () => { await window.api.deleteAudioRule(stored!.id); onBack() }) }} title={reciterKey === null ? 'Remove your default rule: the one that comes with the app applies again' : 'Remove this rule: the default rule applies to this reciter again'}><Trash2 size={13} /> Delete</Button>
          <Button size="sm" disabled={!dirty || saving || errors.length > 0 || (draft.refs.length === 0 && !stored?.target)} onClick={save}><Save size={13} /> {saving ? saveStage ?? 'Saving…' : 'Save rule'}</Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        {/* left: the channel strip, simplest module first */}
        <aside className="w-[clamp(300px,34%,420px)] shrink-0 overflow-y-auto border-r border-border">
          <div className="border-b border-border px-4 py-3 text-[11px] leading-snug text-muted">
            <div className="flex items-center gap-2"><Badge tone={on ? 'info' : 'muted'} className="whitespace-nowrap">{on ? `${on} module${on === 1 ? '' : 's'} on` : 'no processing'}</Badge>
              <button type="button" className="text-muted hover:text-text disabled:opacity-40" disabled={!on || !editable} onClick={() => setModules(defaultModules())} title="Switch every module off and return every knob to its default"><RotateCcw size={11} className="inline" /> reset all</button></div>
            <div className="mt-1.5"><span className="font-medium text-text">Signal flow:</span> {SIGNAL_FLOW}.</div>
            <div className="mt-1">{mode === 'try' ? 'These are the settings the rule gives this recording. Changes here are for listening only and are not saved.'
              : !ref ? 'Add a reference recording on the right to start.'
              : following ? (followReady ? `Reference ${refIndex + 1} follows reference 1: it has been auto-set to sound like reference 1 does after its settings (tone, evenness, static, ring, room, loudness). Change anything and this reference keeps settings of its own.` : 'Auto-setting this recording to sound like reference 1 does after its settings. This takes 10 to 30 seconds…')
              : `Settings of reference ${refIndex + 1}. The rule’s target is how the references sound after their settings.`}</div>
          </div>
          <div className={clsx(!editable && 'pointer-events-none opacity-50')}>
            {MODULE_ORDER.map((key) => (
              <ModuleCard key={key} title={MODULE_TITLES[key]} on={strip(key).on} onToggle={(v) => update(key, { on: v } as Partial<Modules[typeof key]>)}
                onReset={() => setModules((m) => ({ ...m, [key]: { ...defaultModules()[key], on: (m[key] as { on: boolean }).on } }))}
                changed={JSON.stringify({ ...modules[key], on: false }) !== JSON.stringify({ ...defaultModules()[key], on: false })}>
                {KNOBS[key].map((k) => (
                  <KnobRow key={k.key} knob={k} value={strip(key)[k.key]} disabled={!strip(key).on}
                    error={errors.find((e) => e.path.includes(`.${k.key}`) && e.path.includes(`[${look.chain.findIndex((st) => st.id === key)}]`))?.message}
                    onChange={(v) => update(key, { [k.key]: v } as Partial<Modules[typeof key]>)} />
                ))}
              </ModuleCard>
            ))}
          </div>
        </aside>

        {/* right: the rule's references (or a recording to try it on), A/B player, EQ */}
        <main className="min-w-0 flex-1 overflow-y-auto p-5 space-y-4">
          <div className="rounded-xl border border-border bg-surface px-4 py-3 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <Segmented label="What the editor shows" value={mode} onChange={(m) => setMode(m)} options={[
                { value: 'setup', label: 'Set up the rule', title: 'Choose up to five reference recordings and dial in their settings' },
                { value: 'try', label: 'Try it on a recording', title: 'Hear what the saved rule does to any recording, exactly as an upload would get it' },
              ]} />
              <span className="w-full text-[11.5px] leading-snug text-muted">{status}</span>
            </div>
            {mode === 'setup' ? (
              <div className="mt-3 border-t border-border pt-3">
                <div className="mb-1.5 text-muted">Reference recordings for {reciterName} ({draft.refs.length} of {MAX_REFERENCES}). Edit the first. The others follow it: each is auto-set to sound like the first does after its settings, until you change it. The target is the mean of all of them.</div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {draft.refs.map((r, i) => (
                    <span key={r.recordId} className={clsx('inline-flex max-w-full items-center gap-1 rounded-lg border px-2 py-1', i === refIndex ? 'border-accent bg-accent/10' : 'border-border')}>
                      <button type="button" className="min-w-0 truncate text-left no-drag" onClick={() => setRefIndex(i)} title={name(r.recordId)}>
                        <span className="font-medium">{i + 1}.</span> {short(r.recordId)} <span className="text-muted">{i === 0 ? '· sets the sound' : r.modules ? '· own settings' : '· follows 1'}</span>
                      </button>
                      {i > 0 && r.modules && <button type="button" className="text-muted hover:text-text no-drag" onClick={() => setDraft((d) => ({ ...d, refs: d.refs.map((x, k) => (k === i ? { ...x, modules: null } : x)) }))} title="Drop this reference’s own settings and follow reference 1 again"><Undo2 size={12} /></button>}
                      <button type="button" className="text-muted hover:text-err no-drag" onClick={() => removeRef(i)} title="Remove from the rule"><X size={12} /></button>
                    </span>
                  ))}
                  {draft.refs.length < MAX_REFERENCES && (
                    <Select value="" onChange={(e) => addRef(e.target.value)} className="h-7.5 max-w-[240px] text-xs" title="Add a reference recording">
                      <option value="">+ Add a recording…</option>
                      {pool.filter((r) => !draft.refs.some((x) => x.recordId === r.id)).map((r) => <option key={r.id} value={r.id}>{reciterKey === null && r.reciterFolder ? `${r.reciterFolder} / ` : ''}{r.fileName}</option>)}
                    </Select>
                  )}
                </div>
              </div>
            ) : (
              <div className="mt-3 flex flex-wrap items-end gap-3 border-t border-border pt-3">
                <label className="min-w-0 flex-1 text-muted">
                  <div className="mb-1">Recording to try the rule on</div>
                  <Select value={tryId} onChange={(e) => { setTryId(e.target.value); setTryModules(defaultModules()) }} className="h-8 w-full text-[13px]">
                    {pool.map((r) => <option key={r.id} value={r.id}>{reciterKey === null && r.reciterFolder ? `${r.reciterFolder} / ` : ''}{r.fileName}</option>)}
                  </Select>
                </label>
                {dirty && <span className="pb-1.5 text-warn">Save the rule first: this uses the saved one.</span>}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={!record || !!autoBusy || !editable || (mode === 'try' && dirty)} onClick={autoSet}
              title={mode === 'try' ? 'Measures this recording and steers it to the rule, exactly as an upload would: tone, evenness, static, ringing after “s” sounds, loudness. Takes 10 to 30 seconds.' : 'A starting point: sets every module on this reference from the default rule. Then adjust by ear. Takes 10 to 30 seconds.'}>
              <WandSparkles size={13} /> {autoBusy ? (autoBusy.total ? `Measuring ${autoBusy.done}/${autoBusy.total}…` : autoBusy.stage ?? 'Measuring…') : mode === 'try' ? 'Apply the rule' : 'Auto-set'}</Button>
            <Button size="sm" variant="ghost" disabled={!record || analysing} onClick={analyse} title="Measure the whole recording: loudness, peaks, hiss, rumble, clipping"><Waves size={13} /> {analysing ? 'Analysing…' : analysis ? 'Re-analyse' : 'Analyse recording'}</Button>
          </div>
          {analysis && (
            <div className="@container rounded-xl border border-border bg-surface px-4 py-3 text-xs"><div className="grid grid-cols-2 gap-x-6 gap-y-3 @lg:grid-cols-4">
              <Stat label="Length" value={fmtTime(analysis.durationSec)} hint={`${Math.round(analysis.sampleRate / 1000)} kHz · ${analysis.channels === 1 ? 'mono' : analysis.channels === 2 ? 'stereo' : `${analysis.channels} ch`}`} />
              <Stat label="Loudness" value={`${analysis.lufs.toFixed(1)} LUFS`} hint={`range ${analysis.lra.toFixed(1)} LU`} title="Integrated loudness of the whole recording, and how much it varies (loudness range)." />
              <Stat label="True peak" value={db(analysis.truePeak, 'dBTP')} hint={analysis.clipped ? 'clipped' : `${analysis.hotSamplesPct.toFixed(3)} % near full scale`} tone={analysis.clipped ? 'err' : undefined} title="The highest inter-sample peak. A little above 0 on a decoded AAC file is normal; clipping shows as a large share of samples near full scale." />
              <Stat label="Hiss · rumble" value={`${analysis.hissDb.toFixed(0)} · ${analysis.rumbleDb.toFixed(0)} dB`} hint="below the voice" title="Background hiss and low rumble, measured relative to the voice. Lower (more negative) is cleaner." />
            </div>
              {analysis.hints.length > 0 && <div className="mt-3 border-t border-border pt-2 text-[11px] text-muted">{analysis.hints.join(' · ')}</div>}
            </div>
          )}
          {!auto && followReady && followed && (
            <div className="rounded-xl border border-border bg-surface px-4 py-3 text-xs">
              <div><b>Follows reference 1.</b> <span className="text-muted">{followed.result.how.charAt(0).toUpperCase() + followed.result.how.slice(1)}. This is how close it gets; change any setting to give this reference settings of its own.</span></div>
              {followed.result.report && (
                <div className="mt-2 border-t border-border pt-2">
                  <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] gap-x-4 gap-y-1 text-[11.5px] leading-snug">
                    <div className="text-muted">Measured on the processed result</div><div className="text-right text-muted">Before</div><div className="text-right text-muted">After</div><div className="text-right text-muted">Reference 1</div>
                    {followed.result.report.map((r) => (
                      <div key={r.what} className="contents">
                        <div>{r.what}</div><div className="text-right tabular-nums text-muted">{r.before}</div>
                        <div className={clsx('text-right tabular-nums font-medium', !r.ok && 'text-warn')}>{r.after}</div><div className="text-right tabular-nums text-muted">{r.target}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <details className="mt-2 border-t border-border pt-2">
                <summary className="cursor-pointer select-none text-[11.5px] text-muted hover:text-text no-drag">Why each module was set this way</summary>
                <ul className="mt-2 space-y-1 text-[11.5px] leading-snug">
                  {groupNotes(followed.result.notes).map((n, i) => <li key={i}><span className="font-medium">{n.modules}.</span> <span className="text-muted">{n.text}</span></li>)}
                </ul>
              </details>
            </div>
          )}
          {auto && (
            <div className="rounded-xl border border-border bg-surface px-4 py-3 text-xs">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1"><b>{mode === 'try' ? 'Rule applied.' : 'Auto-set done.'}</b> <span className="text-muted">{auto.how.charAt(0).toUpperCase() + auto.how.slice(1)}. {mode === 'try' ? 'This is what an upload of this recording gets.' : 'Nothing is saved until you press Save rule.'}</span></div>
                <Button size="sm" variant="ghost" onClick={() => { setModules(auto.before); setAuto(null) }} title="Put the strip back to how it was before"><Undo2 size={13} /> Undo</Button>
                <button type="button" className="text-muted hover:text-text no-drag" onClick={() => setAuto(null)} title="Hide (keeps the settings)"><X size={14} /></button>
              </div>
              {auto.report && (
                <div className="mt-2 border-t border-border pt-2">
                  <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] gap-x-4 gap-y-1 text-[11.5px] leading-snug">
                    <div className="text-muted">Measured on the processed result</div><div className="text-right text-muted">Before</div><div className="text-right text-muted">After</div><div className="text-right text-muted">Rule’s target</div>
                    {auto.report.map((r) => (
                      <div key={r.what} className="contents">
                        <div>{r.what}</div><div className="text-right tabular-nums text-muted">{r.before}</div>
                        <div className={clsx('text-right tabular-nums font-medium', !r.ok && 'text-warn')}>{r.after}</div><div className="text-right tabular-nums text-muted">{r.target}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {auto.findings.length > 0 && <div className="mt-2 border-t border-border pt-2 text-[11.5px] text-warn">{auto.findings.join(' ')}</div>}
              <details className="mt-2 border-t border-border pt-2">
                <summary className="cursor-pointer select-none text-[11.5px] text-muted hover:text-text no-drag">Why each module was set this way</summary>
                <ul className="mt-2 space-y-1 text-[11.5px] leading-snug">
                  {groupNotes(auto.notes).map((n, i) => <li key={i}><span className="font-medium">{n.modules}.</span> <span className="text-muted">{n.text}</span></li>)}
                </ul>
              </details>
              {auto.failed.length > 0 && <div className="mt-2 border-t border-border pt-2 text-[11px] text-warn">Could not be read: {auto.failed.map((f) => `${f.file} (${f.message})`).join(' · ')}</div>}
            </div>
          )}
          {errors.length > 0 && (
            <div className="rounded-xl border border-err/40 bg-err/6 px-4 py-3 text-xs"><b>The plugin rejects some values:</b> {errors.map((e) => `${e.path}: ${e.message}`).join(' · ')}</div>
          )}
          {!record ? <Empty icon={<AudioLines size={28} />} title={mode === 'setup' ? 'Add a reference recording' : 'Choose a recording'} hint={mode === 'setup' ? (reciterKey === null ? 'Pick a recording that sounds the way every reciter without their own rule should, dial it in, then save. Until then the rule that comes with the app applies.' : 'Pick one of this reciter’s best recordings above, dial in how it should sound, then save. Every upload is steered to that sound.') : undefined} />
            : <Workbench key={record.id} recordId={record.id} look={look} lookOk={validation.ok} winStart={start} onWinStart={(s) => setStart((p) => (Math.abs(p - s) < 0.01 ? p : s))} />}
          <div className={clsx(!editable && 'pointer-events-none opacity-50')}><EqEditor eq={modules.eq} onChange={(eq) => setModules((m) => ({ ...m, eq }))} /></div>
        </main>
      </div>
    </div>
  )
}

function Stat({ label, value, hint, tone, title }: { label: string; value: string; hint?: string; tone?: 'err'; title?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <div className="text-[11px] text-muted">{label}</div>
      <div className={clsx('whitespace-nowrap text-[13px] tabular-nums', tone === 'err' && 'text-err')}>{value}</div>
      {hint && <div className="truncate text-[10.5px] text-muted" title={hint}>{hint}</div>}
    </div>
  )
}

// ── a module card: title, on/off, reset, knobs ────────────────────────────────

function ModuleCard({ title, on, changed, onToggle, onReset, children }: { title: string; on: boolean; changed: boolean; onToggle: (v: boolean) => void; onReset: () => void; children: React.ReactNode }) {
  return (
    <section className={clsx('border-b border-border px-4 py-3', !on && 'opacity-75')}>
      <div className="flex items-center gap-2">
        <div className="text-[13px] font-medium">{title}</div>
        {changed && <Badge tone="info">edited</Badge>}
        <div className="ml-auto flex items-center gap-3">
          {changed && <button type="button" className="text-[11px] text-muted hover:text-text no-drag" onClick={onReset} title="Back to this module's defaults"><RotateCcw size={11} className="inline" /> reset</button>}
          <Switch checked={on} onChange={onToggle} label={title} />
        </div>
      </div>
      <div className="mt-3 space-y-3.5">{children}</div>
    </section>
  )
}

/** One knob: label, full description (never truncated), then the control. */
function KnobRow({ knob, value, disabled, error, onChange }: { knob: Knob; value: unknown; disabled: boolean; error?: string; onChange: (v: unknown) => void }) {
  if (knob.kind === 'toggle') {
    return (
      <div className={clsx(disabled && 'opacity-50')}>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[12px]">{knob.label}</div>
            <div className="text-[11px] leading-snug text-muted">{knob.desc}</div>
          </div>
          <Switch checked={value === true} onChange={(v) => onChange(v)} disabled={disabled} label={knob.label} />
        </div>
      </div>
    )
  }
  if (knob.kind === 'choice') {
    return (
      <div className={clsx(disabled && 'opacity-50')}>
        <div className="text-[12px]">{knob.label}</div>
        <div className="text-[11px] leading-snug text-muted">{knob.desc}</div>
        <Select value={String(value)} onChange={(e) => onChange(e.target.value)} disabled={disabled} className="mt-1.5 h-7.5 w-full text-xs">
          {knob.choices!.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </Select>
      </div>
    )
  }
  const n = typeof value === 'number' ? value : Number(value) || 0
  const k = { min: knob.min!, max: knob.max!, step: knob.step!, log: knob.log }
  return (
    <div className={clsx(disabled && 'opacity-50')}>
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-[12px]">{knob.label}</div>
        <div className="text-[11px] tabular-nums text-muted">{fmtNum(n, k.step)}{knob.unit ? ` ${knob.unit}` : ''}</div>
      </div>
      <div className="text-[11px] leading-snug text-muted">{knob.desc}</div>
      <div className="mt-1.5 flex items-center gap-2">
        <Slider value={toPos(k, n)} min={k.log ? 0 : k.min} max={k.log ? SLIDER_STEPS : k.max} step={k.log ? 1 : k.step} onChange={(p) => onChange(fromPos(k, p))} disabled={disabled} className="flex-1" />
        <input type="number" value={fmtNum(n, k.step)} min={k.min} max={k.max} step={k.step} disabled={disabled}
          onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) onChange(Math.min(k.max, Math.max(k.min, v))) }}
          className={clsx('h-7 w-24 rounded-lg border bg-surface px-1.5 text-right text-[12px] tabular-nums no-drag', error ? 'border-err' : 'border-border')} />
        <span className="w-10 text-[10.5px] text-muted">{knob.unit}</span>
      </div>
      {error && <div className="mt-0.5 text-[11px] text-err">{error}</div>}
    </div>
  )
}

// ── EQ: interactive curve + per-band knobs ────────────────────────────────────

type EqNode = 'hp' | 'ls' | 'b1' | 'b2' | 'b3' | 'b4' | 'hs' | 'lp'
const EQ_NODES: { id: EqNode; label: string; colour: string }[] = [
  { id: 'hp', label: 'High-pass', colour: '#f97316' }, { id: 'ls', label: 'Low shelf', colour: '#eab308' },
  { id: 'b1', label: 'Band 1', colour: '#22c55e' }, { id: 'b2', label: 'Band 2', colour: '#06b6d4' }, { id: 'b3', label: 'Band 3', colour: '#3b82f6' }, { id: 'b4', label: 'Band 4', colour: '#a855f7' },
  { id: 'hs', label: 'High shelf', colour: '#ec4899' }, { id: 'lp', label: 'Low-pass', colour: '#ef4444' },
]
const F_LO = 20, F_HI = 20000, DB_RANGE = 24
const xOf = (f: number, w: number) => (Math.log(f / F_LO) / Math.log(F_HI / F_LO)) * w
const fOf = (x: number, w: number) => F_LO * Math.pow(F_HI / F_LO, Math.min(1, Math.max(0, x / w)))
const yOf = (dbv: number, h: number) => h / 2 - (dbv / DB_RANGE) * (h / 2)
const dbOfY = (y: number, h: number) => Math.max(-DB_RANGE, Math.min(DB_RANGE, ((h / 2 - y) / (h / 2)) * DB_RANGE))

function nodeState(eq: EqState, id: EqNode): { on: boolean; freq: number; gain: number | null; q: number } {
  if (id === 'hp') return { ...eq.hp, gain: null }
  if (id === 'lp') return { ...eq.lp, gain: null }
  if (id === 'ls') return eq.ls
  if (id === 'hs') return eq.hs
  return eq.bands[Number(id[1]) - 1]!
}
function withNode(eq: EqState, id: EqNode, patch: Partial<{ on: boolean; freq: number; gain: number; q: number }>): EqState {
  if (id === 'hp') return { ...eq, hp: { ...eq.hp, ...(patch.on !== undefined ? { on: patch.on } : {}), ...(patch.freq !== undefined ? { freq: patch.freq } : {}), ...(patch.q !== undefined ? { q: patch.q } : {}) } }
  if (id === 'lp') return { ...eq, lp: { ...eq.lp, ...(patch.on !== undefined ? { on: patch.on } : {}), ...(patch.freq !== undefined ? { freq: patch.freq } : {}), ...(patch.q !== undefined ? { q: patch.q } : {}) } }
  if (id === 'ls') return { ...eq, ls: { ...eq.ls, ...patch } }
  if (id === 'hs') return { ...eq, hs: { ...eq.hs, ...patch } }
  const i = Number(id[1]) - 1
  return { ...eq, bands: eq.bands.map((b, j) => (j === i ? { ...b, ...patch } : b)) }
}
const FREQ_KNOB: Knob = { key: 'freq', label: 'Frequency', desc: '', kind: 'number', unit: 'Hz', min: 20, max: 20000, step: 1, log: true }
const GAIN_KNOB: Knob = { key: 'gain', label: 'Gain', desc: '', kind: 'number', unit: 'dB', min: -24, max: 24, step: 0.1 }
const Q_KNOB: Knob = { key: 'q', label: 'Q (width)', desc: '', kind: 'number', unit: '', min: 0.1, max: 10, step: 0.01, log: true }

function EqEditor({ eq, onChange }: { eq: EqState; onChange: (eq: EqState) => void }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [selected, setSelected] = useState<EqNode>('b1')
  const drag = useRef<EqNode | null>(null)
  const freqs = useMemo(() => logFrequencies(300), [])
  const [width, setWidth] = useState(0)   // redraw the curve at the new size when the column resizes
  useEffect(() => { const c = ref.current; if (!c) return; const ro = new ResizeObserver(() => setWidth(c.clientWidth)); ro.observe(c); return () => ro.disconnect() }, [])

  useEffect(() => {
    const c = ref.current; if (!c) return
    const dpr = window.devicePixelRatio || 1
    const w = c.clientWidth, h = c.clientHeight
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr) }
    const ctx = c.getContext('2d'); if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    const cs = getComputedStyle(c)
    const muted = cs.getPropertyValue('--muted').trim() || '#64748b', accent = cs.getPropertyValue('--accent').trim() || '#6366f1', text = cs.getPropertyValue('--text').trim() || '#fff'
    // grid
    ctx.strokeStyle = muted; ctx.globalAlpha = 0.18; ctx.lineWidth = 1
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) { const x = Math.round(xOf(f, w)) + 0.5; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke() }
    for (const d of [-18, -12, -6, 0, 6, 12, 18]) { const y = Math.round(yOf(d, h)) + 0.5; ctx.globalAlpha = d === 0 ? 0.4 : 0.18; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke() }
    ctx.globalAlpha = 0.7; ctx.fillStyle = muted; ctx.font = '10px ui-sans-serif, system-ui'
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) ctx.fillText(f >= 1000 ? `${f / 1000}k` : String(f), xOf(f, w) + 3, h - 4)
    for (const d of [-12, 0, 12]) ctx.fillText(`${d > 0 ? '+' : ''}${d}`, 3, yOf(d, h) - 3)
    // curve
    ctx.globalAlpha = 1
    const pts = freqs.map((f) => [xOf(f, w), yOf(eqResponseDb(eq, f), h)] as const)
    ctx.beginPath(); ctx.moveTo(pts[0]![0], pts[0]![1]); for (const [x, y] of pts) ctx.lineTo(x, y)
    ctx.strokeStyle = eq.on ? accent : muted; ctx.lineWidth = 2; ctx.stroke()
    ctx.lineTo(w, yOf(0, h)); ctx.lineTo(0, yOf(0, h)); ctx.closePath(); ctx.fillStyle = accent; ctx.globalAlpha = eq.on ? 0.12 : 0.04; ctx.fill()
    // nodes
    ctx.globalAlpha = 1
    for (const n of EQ_NODES) {
      const st = nodeState(eq, n.id)
      const x = xOf(st.freq, w), y = st.gain === null ? yOf(0, h) : yOf(st.gain, h)
      ctx.beginPath(); ctx.arc(x, y, selected === n.id ? 7 : 5.5, 0, Math.PI * 2)
      ctx.fillStyle = n.colour; ctx.globalAlpha = st.on && eq.on ? 1 : 0.3; ctx.fill()
      if (selected === n.id) { ctx.strokeStyle = text; ctx.lineWidth = 1.5; ctx.globalAlpha = 1; ctx.stroke() }
    }
    ctx.globalAlpha = 1
  }, [eq, selected, freqs, width])

  const hit = (e: React.PointerEvent<HTMLCanvasElement>): EqNode | null => {
    const r = e.currentTarget.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top
    let best: EqNode | null = null, bd = 14
    for (const n of EQ_NODES) { const st = nodeState(eq, n.id); const d = Math.hypot(xOf(st.freq, r.width) - x, (st.gain === null ? yOf(0, r.height) : yOf(st.gain, r.height)) - y); if (d < bd) { bd = d; best = n.id } }
    return best
  }
  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const n = hit(e); if (!n) return
    setSelected(n); drag.current = n; e.currentTarget.setPointerCapture(e.pointerId)
    if (!nodeState(eq, n).on || !eq.on) onChange(withNode({ ...eq, on: true }, n, { on: true }))
  }
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const n = drag.current; if (!n) return
    const r = e.currentTarget.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top
    const freq = Math.round(fOf(x, r.width))
    const st = nodeState(eq, n)
    if (st.gain === null) onChange(withNode(eq, n, { freq, q: Math.max(0.1, Math.min(10, Number((0.707 * Math.pow(10, (r.height / 2 - y) / r.height)).toFixed(2)))) }))   // pass filters: drag up/down for Q
    else onChange(withNode(eq, n, { freq, gain: Number(dbOfY(y, r.height).toFixed(1)) }))
  }
  const onUp = () => { drag.current = null }
  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const st = nodeState(eq, selected)
    const q = Math.max(0.1, Math.min(10, Number((st.q * Math.pow(1.1, -Math.sign(e.deltaY))).toFixed(2))))
    onChange(withNode(eq, selected, { q }))
  }
  const sel = nodeState(eq, selected)
  const node = EQ_NODES.find((n) => n.id === selected)!
  return (
    <section className="rounded-xl border border-border bg-surface">
      <div className="border-b border-border px-4 py-2.5">
        <div className="flex h-8 items-center gap-2">
          <div className="text-[13px] font-medium">Equaliser</div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => onChange(defaultModules().eq)} title="All bands off and back to their defaults"><RotateCcw size={13} /> Reset EQ</Button>
            <Switch checked={eq.on} onChange={(on) => onChange({ ...eq, on })} label="Equaliser" />
          </div>
        </div>
        <div className="text-[11px] leading-snug text-muted" title={`ffmpeg filters: highpass, lowshelf, equalizer ×${EQ_BANDS}, highshelf, lowpass`}>Drag a point to set its frequency and gain (the pass filters: up and down sets Q). Scroll on the curve to change the selected band’s width.</div>
      </div>
      <canvas ref={ref} className={clsx('block h-56 w-full cursor-crosshair', !eq.on && 'opacity-70')} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onWheel={onWheel} />
      <div className="flex flex-wrap gap-1.5 border-t border-border px-4 py-2">
        {EQ_NODES.map((n) => { const st = nodeState(eq, n.id); return (
          <button key={n.id} type="button" onClick={() => setSelected(n.id)}
            className={clsx('inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs no-drag transition-colors', selected === n.id ? 'border-accent/60 bg-accent/10 text-text' : 'border-border text-muted hover:text-text')}>
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: n.colour, opacity: st.on ? 1 : 0.35 }} />{n.label}
            <span className="tabular-nums text-muted">{st.freq >= 1000 ? `${(st.freq / 1000).toFixed(st.freq % 1000 ? 1 : 0)}k` : st.freq}{st.gain !== null && st.gain !== 0 ? ` ${st.gain > 0 ? '+' : ''}${st.gain.toFixed(1)}` : ''}</span>
          </button>
        ) })}
      </div>
      <div className={clsx('border-t border-border px-4 py-3', !eq.on && 'opacity-60')}>
        <div className="flex items-center gap-2">
          <span className="inline-block h-3 w-3 shrink-0 rounded-full" style={{ background: node.colour }} />
          <span className="whitespace-nowrap text-[13px] font-medium">{node.label}</span>
          <label className="ml-auto inline-flex shrink-0 items-center gap-2 text-xs text-muted"><Switch checked={sel.on} onChange={(v) => onChange(withNode(eq, selected, { on: v }))} label={`${node.label} on`} /> on</label>
        </div>
        <div className="mt-0.5 text-[11px] leading-snug text-muted">{selected === 'hp' ? 'Removes everything below the frequency, 12 dB per octave. Q 0.707 is flat; higher adds a bump at the corner.' : selected === 'lp' ? 'Removes everything above the frequency, 12 dB per octave.' : selected === 'ls' ? 'Raises or lowers everything below the frequency.' : selected === 'hs' ? 'Raises or lowers everything above the frequency.' : 'Boosts or cuts a band around the frequency; Q sets how narrow the band is.'}</div>
      </div>
      <div className={clsx('grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-x-6 gap-y-3 px-4 pb-3', !eq.on && 'opacity-60')}>
        <KnobRow knob={FREQ_KNOB} value={sel.freq} disabled={!eq.on || !sel.on} onChange={(v) => onChange(withNode(eq, selected, { freq: Number(v) }))} />
        {sel.gain !== null && <KnobRow knob={GAIN_KNOB} value={sel.gain} disabled={!eq.on || !sel.on} onChange={(v) => onChange(withNode(eq, selected, { gain: Number(v) }))} />}
        <KnobRow knob={Q_KNOB} value={sel.q} disabled={!eq.on || !sel.on} onChange={(v) => onChange(withNode(eq, selected, { q: Number(v) }))} />
      </div>
    </section>
  )
}

// ── Streaming A/B workbench ───────────────────────────────────────────────────
//
// The window is a 45 s slice of the recording, rendered as 5 s chunks on a fixed grid. Processed chunks
// come from the plugin with a 4 s pre-roll (skipped on playback) so filters are warm at the join; the
// original chunks are plain cuts. The chunk under the playhead renders first, then the ones ahead, so a
// knob change is audible within about half a second and the rest fills in while you listen. All chunks
// play from one Web Audio clock; a chunk that re-renders crossfades in at its exact position.

type Side = 'original' | 'processed'
const TILE = 5
const WINDOW = 45
const XFADE = 0.03
/** neighbouring chunks overlap by this much on each side and crossfade, hiding the few-sample inexactness of ffmpeg cuts */
const JOIN = 0.01
const tileKey = (kind: Side, index: number) => `${kind}:${index}`

interface Loaded {
  key: string; kind: Side; index: number; gen: number
  buffer: AudioBuffer; offset: number; peaks: number[]; gainDb: number; lufs: number; truePeak: number; channels: number; warnings: string[]
  /** K-weighted mean square of the chunk's own 5 s (no pre/post-roll), per channel: what loudness matching compares */
  power: number
}
interface Voice {
  src: AudioBufferSourceNode
  /** fixed join envelope + per-chunk level compensation; written once at creation, never cancelled */
  gain: GainNode
  /** stop/pause/seek fades; only ever carries explicitly anchored ramps */
  mute: GainNode
  tile: Loaded
  endAt: number
  stopAt?: number
}

/**
 * Gain changes must be scheduled ahead of the render head: anything the audio thread has already passed lands
 * as a hard step. `currentTime` lags by a few ms and a seek issues ~36 nodes' worth of automation from the
 * main thread, so 50 ms of slack; it is imperceptible on a pause, seek or switch.
 */
const LEAD = 0.05
/** How far ahead of the playhead voices are scheduled; further chunks get theirs as playback approaches. */
const HORIZON = 15
/** Fade when a voice starts or stops mid-waveform (play, pause, seek, side switch). */
const ENTER = 0.012

/**
 * Why three gain stages: Web Audio automation that is *cancelled* behaves subtly (a later ramp interpolates
 * from the previous event, which may be seconds old). So nothing here is ever cancelled on a voice: the join
 * envelope is written once, stops are explicit ramps on a separate mute node, and which side is audible is
 * decided on two bus gains that carry nothing but side switches.
 */
class TileTransport {
  // the plugin writes 48 kHz; decoding into a 44.1 kHz context would resample every chunk on its own and roughen the joins
  readonly ctx = new AudioContext({ sampleRate: 48000 })
  /** every voice goes through here (one place to meter or tap the mix) */
  readonly master = this.ctx.createGain()
  private readonly bus: Record<Side, GainNode> = { original: this.ctx.createGain(), processed: this.ctx.createGain() }
  side: Side = 'processed'
  loop = true
  playing = false
  private startedAt = 0           // ctx time at which recording second 0 plays
  private pos = 0                 // absolute recording seconds while paused
  private win = { start: 0, end: WINDOW }
  private tiles = new Map<string, Loaded>()
  private voices = new Map<string, Voice>()
  /** the next lap of the loop, scheduled ahead on the audio clock so the wrap is gapless */
  private lap: { at: number; startedAt: number; voices: Map<string, Voice> } | null = null
  /** processed chunks are each levelled on their own; play them all at the gain of the first chunk of this look */
  refGain: number | null = null
  /** extra gain on the original side (loudness match), linear */
  originalGain = 1

  constructor() {
    this.master.connect(this.ctx.destination)
    for (const side of ['original', 'processed'] as const) {
      this.bus[side].gain.setValueAtTime(this.busTarget(side), 0)
      this.bus[side].connect(this.master)
    }
  }

  get time(): number { return this.playing ? this.ctx.currentTime - this.startedAt : this.pos }

  /** Diagnostics: with `window.__yjDebug = true`, every scheduling decision is appended to `window.__yjLog` with the audio-clock time. */
  private log(msg: string): void {
    const w = window as unknown as { __yjDebug?: boolean; __yjLog?: string[] }
    if (!w.__yjDebug) return
    ;(w.__yjLog ??= []).push(`${this.ctx.currentTime.toFixed(3)} ${msg}`)
  }

  private busTarget(side: Side): number { return side !== this.side ? 0 : side === 'original' ? this.originalGain : 1 }
  private compensation(t: Loaded): number { return t.kind === 'original' || this.refGain === null ? 1 : Math.pow(10, (this.refGain - t.gainDb) / 20) }

  /**
   * Start one chunk's voice. `ref` is the earliest ctx time it may sound (now + lead, or the loop wrap);
   * `base` is the ctx time of recording second 0 for the lap it belongs to.
   */
  private schedule(t: Loaded, into: Map<string, Voice>, base: number, ref: number, fadeIn: number): void {
    const pre = Math.min(JOIN, t.offset)
    const post = Math.min(JOIN, Math.max(0, t.buffer.duration - t.offset - TILE))
    const begin = base + t.index * TILE - pre
    const nominalEnd = base + t.index * TILE + TILE
    const endAt = nominalEnd + post
    let at = begin, offset = t.offset - pre, ramp = pre + JOIN   // natural join: ramp over the overlap
    if (begin < ref) {   // entering mid-chunk
      // The playhead is already in this chunk's tail overlap: the next chunk covers that moment on its own.
      // (Starting both would fade this one in and cut it off ten milliseconds later — a click.)
      if (ref > nominalEnd - JOIN) return
      const skip = ref - begin; offset += skip; at = ref; ramp = fadeIn
    }
    const dur = endAt - at
    if (dur <= 0.01) return
    const src = this.ctx.createBufferSource(); src.buffer = t.buffer
    const gain = this.ctx.createGain(), mute = this.ctx.createGain()
    const g = this.compensation(t)
    // A GainNode is 1 until its first event. The source's start rounds to a sample frame, sometimes the one just
    // before `at`, which would then play at full level: a single-sample spike. So the envelope starts at 0 from the outset.
    gain.gain.setValueAtTime(0, 0)
    if (ramp > 0) { gain.gain.setValueAtTime(0, at); gain.gain.linearRampToValueAtTime(g, at + ramp) } else gain.gain.setValueAtTime(g, at)
    // every voice ends on a fade, however short it is
    const fadeOutStart = Math.max(at + ramp, endAt - (post + JOIN))
    if (fadeOutStart < endAt) { gain.gain.setValueAtTime(g, fadeOutStart); gain.gain.linearRampToValueAtTime(0, endAt) }
    mute.gain.setValueAtTime(1, 0)
    src.connect(gain).connect(mute).connect(this.bus[t.kind])
    src.start(at, offset, dur)
    this.log(`schedule ${t.key} at=${at.toFixed(3)} offset=${offset.toFixed(3)} dur=${dur.toFixed(3)} ramp=${ramp.toFixed(3)} g=${g.toFixed(3)} end=${endAt.toFixed(3)}`)
    const v: Voice = { src, gain, mute, tile: t, endAt }
    src.onended = () => { if (into.get(t.key) === v) into.delete(t.key) }
    into.set(t.key, v)
  }

  /** Fade a voice out and stop it. The mute node is 1 until its first stop, so anchoring at 1 is exact; an earlier re-stop replaces a later one. */
  private stop(v: Voice, fade: number, at = this.ctx.currentTime + LEAD): void {
    if (v.stopAt !== undefined && v.stopAt <= at) return
    this.log(`stop ${v.tile.key} at=${at.toFixed(3)} fade=${fade} (voice end ${v.endAt.toFixed(3)})`)
    v.src.onended = null
    const m = v.mute.gain
    m.cancelScheduledValues(at)
    m.setValueAtTime(1, at); m.linearRampToValueAtTime(0, at + fade)
    try { v.src.stop(at + fade + 0.02) } catch { /* already stopped */ }
    v.stopAt = at
  }

  private stopAll(fade: number): void {
    for (const v of this.voices.values()) this.stop(v, fade)
    this.voices.clear()
    this.disarmLoop()
  }

  private inWindow(t: Loaded): boolean { const s = t.index * TILE; return s < this.win.end && s + TILE > this.win.start }
  /** Voices exist only for chunks near the playhead (`at` = recording time): keeps every seek and chunk arrival a small amount of work. */
  private inHorizon(t: Loaded, at: number): boolean { const s = t.index * TILE; return s < at + HORIZON && s + TILE > at - TILE }

  private startLap(base: number, ref: number, fadeIn: number): Map<string, Voice> {
    const into = new Map<string, Voice>()
    const at = ref - base
    for (const t of this.tiles.values()) if (this.inWindow(t) && this.inHorizon(t, at)) this.schedule(t, into, base, ref, fadeIn)
    return into
  }

  /** As playback moves on, add voices for the chunks that come within the horizon. */
  private lastExtend = -1
  private extend(): void {
    if (!this.playing) return
    const ref = this.ctx.currentTime + LEAD, at = ref - this.startedAt
    for (const t of this.tiles.values()) if (this.inWindow(t) && this.inHorizon(t, at) && !this.voices.has(t.key)) this.schedule(t, this.voices, this.startedAt, ref, ENTER)
  }

  /** Replace the chunk set. New or re-rendered chunks in the window start at their exact position (crossfading over a stale one); chunks that left the window stop. */
  setTiles(next: Map<string, Loaded>): void {
    this.log(`setTiles n=${next.size}`)
    this.disarmLoop()
    for (const [key, v] of [...this.voices]) {
      const t = next.get(key)
      if (!t || !this.inWindow(t)) { this.stop(v, ENTER); this.voices.delete(key) }
    }
    if (this.playing) {
      const ref = this.ctx.currentTime + LEAD, at = ref - this.startedAt
      for (const t of next.values()) {
        if (!this.inWindow(t)) continue
        const live = this.voices.get(t.key)
        if (!live && !this.inHorizon(t, at)) continue
        if (live && live.tile === t) continue
        if (live) this.stop(live, XFADE)
        this.schedule(t, this.voices, this.startedAt, ref, live ? XFADE : ENTER)
      }
    }
    this.tiles = next
  }

  setWindow(start: number): void { this.setRange(start, start + WINDOW) }

  /** The span playback is confined to: the 45 s window in loop mode, the whole recording in continuous mode. */
  setRange(start: number, end: number): void {
    this.win = { start, end }
    if (this.time < start || this.time >= end) this.seek(start)
    else this.setTiles(this.tiles)
  }

  async play(): Promise<void> {
    if (this.playing) return
    await this.ctx.resume()
    if (this.pos < this.win.start || this.pos >= this.win.end) this.pos = this.win.start
    const ref = this.ctx.currentTime + LEAD
    this.startedAt = ref - this.pos
    this.playing = true
    this.voices = this.startLap(this.startedAt, ref, ENTER)
  }

  pause(): void {
    if (!this.playing) return
    this.pos = this.time
    this.stopAll(ENTER)
    this.playing = false
  }

  seek(t: number): void {
    this.log(`seek ${t.toFixed(3)}`)
    const c = Math.min(Math.max(this.win.start, t), this.win.end - 0.05)
    if (!this.playing) { this.pos = c; return }
    this.stopAll(ENTER)
    const ref = this.ctx.currentTime + LEAD
    this.startedAt = ref - c
    this.voices = this.startLap(this.startedAt, ref, ENTER)
  }

  /** Arm the next lap shortly before the window ends: its voices are scheduled on the audio clock, the current ones fade out into them. */
  private armLoop(): void {
    const wrapAt = this.startedAt + this.win.end
    const base = wrapAt - this.win.start
    this.log(`armLoop wrapAt=${wrapAt.toFixed(3)} base=${base.toFixed(3)} current voices=${[...this.voices.keys()].join(',')}`)
    const voices = this.startLap(base, wrapAt, ENTER)
    for (const v of this.voices.values()) this.stop(v, ENTER, wrapAt)
    this.lap = { at: wrapAt, startedAt: base, voices }
  }
  private disarmLoop(): void {
    if (!this.lap) return
    this.log('disarmLoop')
    for (const v of this.lap.voices.values()) { v.src.onended = null; try { v.src.stop() } catch { /* not started */ } }
    this.lap = null
  }

  /** Called from the display loop. */
  tick(): void {
    if (!this.playing) return
    const now = this.ctx.currentTime
    if (this.lap && now >= this.lap.at) { this.log(`commit lap (late by ${(now - this.lap.at).toFixed(3)})`); this.startedAt = this.lap.startedAt; this.voices = this.lap.voices; this.lap = null; this.lastExtend = -1; return }
    const idx = Math.floor(this.time / TILE)
    if (idx !== this.lastExtend) { this.lastExtend = idx; this.extend() }
    if (this.loop) { if (!this.lap && this.time >= this.win.end - 0.5) this.armLoop() }
    else if (this.time >= this.win.end) this.pause()
  }

  /** Side and loudness-match changes glide on the two bus gains, which carry nothing else. */
  private retarget(): void {
    const at = this.ctx.currentTime + LEAD
    this.log(`retarget side=${this.side} originalGain=${this.originalGain.toFixed(3)}`)
    for (const side of ['original', 'processed'] as const) {
      const g = this.bus[side].gain
      g.cancelAndHoldAtTime(at); g.setTargetAtTime(this.busTarget(side), at, ENTER / 4)
    }
  }
  setSide(side: Side): void { this.side = side; this.retarget() }
  setOriginalGain(g: number): void { this.originalGain = g; this.retarget() }
  /** Known once the first processed chunk of a look arrives — before any voice of that look is scheduled. */
  setRefGain(g: number | null): void { this.refGain = g }
  setLoop(loop: boolean): void { this.loop = loop; if (!loop) this.disarmLoop() }
  dispose(): void { this.pause(); setTimeout(() => void this.ctx.close(), 100) }
}

const decoded = new Map<string, Promise<AudioBuffer>>()
/**
 * Mean square of `seconds` from `offset`, K-weighted as LUFS is (ITU-R BS.1770, 48 kHz coefficients), averaged over
 * channels so a mono original and a stereo (reverb) processed side compare as heard on two speakers. The pre-roll
 * before `offset` warms the filters up.
 */
function kPower(buf: AudioBuffer, offset: number, seconds: number): number {
  const from = Math.max(0, Math.round(offset * buf.sampleRate)), to = Math.min(buf.length, from + Math.round(seconds * buf.sampleRate))
  if (to <= from) return 0
  let sum = 0
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const x = buf.getChannelData(c)
    let a1 = 0, a2 = 0, b1 = 0, b2 = 0, c1 = 0, c2 = 0, d1 = 0, d2 = 0
    for (let i = 0; i < to; i++) {
      const v = x[i]!
      const y = 1.53512485958697 * v - 2.69169618940638 * a1 + 1.19839281085285 * a2 + 1.69065929318241 * b1 - 0.73248077421585 * b2
      a2 = a1; a1 = v; b2 = b1; b1 = y
      const z = y - 2 * c1 + c2 + 1.99004745483398 * d1 - 0.99007225036621 * d2
      c2 = c1; c1 = y; d2 = d1; d1 = z
      if (i >= from) sum += z * z
    }
  }
  return sum / ((to - from) * buf.numberOfChannels)
}

function decode(ctx: AudioContext, file: string): Promise<AudioBuffer> {
  let p = decoded.get(file)
  if (!p) {
    p = fetch(audioUrl(file)).then((r) => { if (!r.ok) throw new Error(`Could not load ${file.split('/').pop()} (${r.status})`); return r.arrayBuffer() }).then((ab) => ctx.decodeAudioData(ab))
    decoded.set(file, p)
    p.catch(() => decoded.delete(file))
    if (decoded.size > 64) decoded.delete(decoded.keys().next().value!)
  }
  return p
}

type Mode = 'loop' | 'continuous'

function Segmented<T extends string>({ label, value, onChange, options }: { label: string; value: T; onChange: (v: T) => void; options: { value: T; label: React.ReactNode; title?: string }[] }) {
  return (
    <div className="inline-flex h-8 shrink-0 overflow-hidden rounded-lg border border-border text-xs" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)} title={o.title}
          className={clsx('inline-flex items-center gap-1 whitespace-nowrap px-2.5 no-drag transition-colors', value === o.value ? 'bg-accent/15 font-medium text-accent' : 'text-muted hover:text-text')}>{o.label}</button>
      ))}
    </div>
  )
}
/** remembered across recordings for the session */
let lastMode: Mode = 'loop'
/** a lane/axis/overview places itself each animation frame: `viewStart` = recording second at the lanes' left edge */
type Placer = (viewStart: number, time: number) => void

/** Continuous mode's view: the playhead in the middle, but never past either end of the recording (there the needle moves instead). */
function followStart(time: number, duration: number): number {
  const max = Number.isFinite(duration) ? Math.max(0, duration - WINDOW) : Infinity
  return Math.min(max, Math.max(0, time - WINDOW / 2))
}

function Workbench({ recordId, look, lookOk, winStart, onWinStart }: { recordId: string; look: AudioLook; lookOk: boolean; winStart: number; onWinStart: (s: number) => void }) {
  const notify = useStore((s) => s.notify)
  const tRef = useRef<TileTransport | null>(null)
  const transport = () => (tRef.current ??= new TileTransport())
  useEffect(() => () => { tRef.current?.dispose(); tRef.current = null }, [])
  useEffect(() => { (window as unknown as { __yjTransport?: TileTransport }).__yjTransport = transport() })   // diagnostics hook (devtools)

  const [overview, setOverview] = useState<AudioOverview | null>(null)
  useEffect(() => {
    let live = true
    window.api.getAudioOverview(recordId).then((o) => { if (live) setOverview(o) }).catch((e) => { if (live) notify('error', errText(e)) })
    return () => { live = false }
  }, [recordId])  // eslint-disable-line react-hooks/exhaustive-deps
  const duration = overview?.durationSec ?? Infinity
  const maxStart = Math.max(0, (Number.isFinite(duration) ? duration : winStart + WINDOW) - WINDOW)
  useEffect(() => { if (winStart > maxStart) onWinStart(Math.max(0, Math.floor(maxStart))) }, [maxStart])  // eslint-disable-line react-hooks/exhaustive-deps

  const [which, setWhich] = useState<Side>('processed')
  const [playing, setPlaying] = useState(false)
  const [mode, setModeState] = useState<Mode>(lastMode)
  const [time, setTime] = useState(winStart)
  const [matchLoudness, setMatchLoudness] = useState(false)
  const [tiles, setTiles] = useState<Map<string, Loaded>>(() => new Map())
  const [tick, setTick] = useState(0)
  // generation = a timestamp: strictly newer than anything the main process has seen, even after a page reload
  const genRef = useRef(Date.now())
  const lookKey = JSON.stringify(look)
  const inflight = useRef(new Set<string>())
  const failed = useRef(new Map<string, string>())
  const refGainRef = useRef<number | null>(null)

  // live values for the animation loop and event handlers (no re-subscribing every render)
  const modeRef = useRef(mode); modeRef.current = mode
  const winRef = useRef(winStart); winRef.current = winStart
  const durRef = useRef(duration); durRef.current = duration

  // look changed → new generation: processed chunks become stale (kept playing until replaced), old renders cancelled
  useEffect(() => {
    genRef.current = Math.max(genRef.current + 1, Date.now())
    refGainRef.current = null
    transport().setRefGain(null)
    for (const k of [...failed.current.keys()]) if (k.startsWith('processed:')) failed.current.delete(k)
    void window.api.cancelAudioTiles(genRef.current, recordId)
    setTick((n) => n + 1)
  }, [lookKey])  // eslint-disable-line react-hooks/exhaustive-deps

  // what playback is confined to: the window (loop) or the whole recording (continuous)
  useEffect(() => {
    const t = transport()
    t.setLoop(mode === 'loop')
    if (mode === 'loop') t.setWindow(winStart)
    else t.setRange(0, Number.isFinite(duration) ? duration : Infinity)
    setTime(t.time)
  }, [winStart, mode, duration])  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { transport().setTiles(tiles) }, [tiles])  // eslint-disable-line react-hooks/exhaustive-deps
  // Match loudness: one gain for the original = how much louder the processed side is, as heard, over the chunks
  // loaded around the view (both sides measured the same way; the processed side with its levelling compensation).
  // Levelling in the preview: every chunk is levelled on its own, but the recording gets ONE gain. Ask for that gain
  // (a whole-recording measurement, a few seconds) and play every chunk with it; until it arrives the first chunk's stands in.
  const [wholeGain, setWholeGain] = useState<number | null>(null)
  useEffect(() => {
    setWholeGain(null)
    if (!look.level || !lookOk) return
    let live = true
    const t = setTimeout(() => {
      window.api.getAudioLevelGain(recordId, look).then((g) => {
        if (!live || g === null) return
        refGainRef.current = g
        transport().setRefGain(g)
        setWholeGain(g)
      }).catch(() => { /* superseded or failed: the first chunk's gain stays */ })
    }, 400)
    return () => { live = false; clearTimeout(t) }
  }, [recordId, lookKey, lookOk])  // eslint-disable-line react-hooks/exhaustive-deps
  const matchDb = useMemo(() => {
    const gen = genRef.current, ref = wholeGain ?? refGainRef.current
    let p = 0, o = 0
    for (const tp of tiles.values()) {
      if (tp.kind !== 'processed' || tp.gen !== gen) continue
      const to = tiles.get(tileKey('original', tp.index))
      if (!to || tp.power < 1e-7 || to.power < 1e-7) continue   // skip silence (below -70 dB)
      p += tp.power * Math.pow(10, ((ref === null ? 0 : ref - tp.gainDb)) / 10); o += to.power
    }
    return o > 0 && p > 0 ? Math.max(-24, Math.min(24, 10 * Math.log10(p / o))) : null
  }, [tiles, lookKey, wholeGain])  // eslint-disable-line react-hooks/exhaustive-deps
  const appliedMatch = useRef(0)
  useEffect(() => {
    const want = matchLoudness && matchDb !== null ? matchDb : 0
    if (Math.abs(want - appliedMatch.current) < 0.1 && (want === 0) === (appliedMatch.current === 0)) return   // ignore drift as chunks come and go
    appliedMatch.current = want
    transport().setOriginalGain(Math.pow(10, want / 20))
  }, [matchLoudness, matchDb])

  // The lanes show [viewStart, viewStart + 45 s]: the fixed window in loop mode, centred on the playhead in continuous mode
  // (held at the start/end of the recording when the playhead is within half a window of it).
  const viewStart = mode === 'loop' ? winStart : followStart(time, duration)
  const lastTile = Number.isFinite(duration) ? Math.max(0, Math.ceil(duration / TILE) - 1) : Infinity
  const first = Math.max(0, Math.floor(viewStart / TILE)), last = Math.min(lastTile, Math.floor((viewStart + WINDOW - 0.001) / TILE))
  const playIndex = Math.floor(time / TILE)

  // Scheduler: the chunks the view needs. Loop: nearest the playhead first. Continuous: the playhead and ahead first, then behind.
  useEffect(() => {
    if (!lookOk || last < first) return
    const centre = Math.min(last, Math.max(first, playIndex))
    const order: number[] = []
    if (mode === 'continuous') { for (let i = centre; i <= last; i++) order.push(i); for (let i = centre - 1; i >= first; i--) order.push(i) }
    else { order.push(centre); for (let d = 1; order.length < last - first + 1; d++) { if (centre + d <= last) order.push(centre + d); if (centre - d >= first) order.push(centre - d) } }
    const gen = genRef.current
    const want: { kind: Side; index: number }[] = []
    for (const index of order) {
      for (const kind of ['processed', 'original'] as const) {
        const key = tileKey(kind, index), have = tiles.get(key)
        const fresh = have && (kind === 'original' || have.gen === gen)
        if (!fresh && !inflight.current.has(key) && !failed.current.has(key)) want.push({ kind, index })
      }
    }
    const budget = 2 - inflight.current.size
    for (const w of want.slice(0, Math.max(0, budget))) {
      const key = tileKey(w.kind, w.index)
      inflight.current.add(key)
      const start = w.index * TILE
      window.api.renderAudioTile({ recordId, kind: w.kind, start, seconds: TILE, ...(w.kind === 'processed' ? { look, generation: gen } : {}) })
        .then(async (r) => {
          if (!r.ok) { if (r.reason !== 'CANCELLED') failed.current.set(key, r.message); return }
          if (w.kind === 'processed' && gen !== genRef.current) return
          const buffer = await decode(transport().ctx, r.tile.file)
          if (w.kind === 'processed' && gen !== genRef.current) return
          const loaded: Loaded = { key, kind: w.kind, index: w.index, gen, buffer, offset: r.tile.offset, peaks: r.tile.peaks, gainDb: r.tile.gainDb, lufs: r.tile.lufs, truePeak: r.tile.truePeak, channels: r.tile.channels, warnings: r.tile.warnings, power: kPower(buffer, r.tile.offset, TILE) }
          if (w.kind === 'processed' && refGainRef.current === null) { refGainRef.current = r.tile.gainDb; transport().setRefGain(r.tile.gainDb) }
          setTiles((prev) => { const next = new Map(prev); next.set(key, loaded); return next })
        })
        .catch((e) => failed.current.set(key, errText(e)))
        .finally(() => { inflight.current.delete(key); setTick((n) => n + 1) })
    }
  }, [recordId, lookKey, lookOk, first, last, playIndex, tiles, tick, mode])  // eslint-disable-line react-hooks/exhaustive-deps

  // Animation loop: the audio clock drives the picture. Every frame each lane, the axis and the overview are slid
  // into place (CSS transforms, no redraw). A jump (seek, window move) eases over ~100 ms instead of snapping.
  const placers = useRef(new Set<Placer>())
  const register = useCallback((p: Placer) => { placers.current.add(p); return () => { placers.current.delete(p) } }, [])
  const dispRef = useRef(winStart)
  const [anchor, setAnchor] = useState(() => Math.floor(winStart) - WINDOW)
  const anchorRef = useRef(anchor); anchorRef.current = anchor
  useEffect(() => {
    let raf = 0, lastText = 0, lastFrame = performance.now()
    const step = (now: number) => {
      const t = transport(); t.tick()
      const tm = t.time
      const target = modeRef.current === 'loop' ? winRef.current : followStart(tm, durRef.current)
      const diff = target - dispRef.current, dt = now - lastFrame
      lastFrame = now
      dispRef.current = Math.abs(diff) > 0.25 ? dispRef.current + diff * (1 - Math.exp(-dt / 35)) : target
      const vs = dispRef.current
      for (const p of placers.current) p(vs, tm)
      // the lanes draw a strip three windows wide; re-centre it before the view reaches its edge
      if (vs < anchorRef.current + WINDOW * 0.25 || vs > anchorRef.current + WINDOW * 1.75) { anchorRef.current = Math.floor(vs) - WINDOW; setAnchor(anchorRef.current) }
      if (now - lastText > 33) { lastText = now; setTime(tm); if (!t.playing) setPlaying(false) }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {   // drop chunks far outside the view to keep memory bounded
    setTiles((prev) => {
      let changed = false; const next = new Map(prev)
      for (const [k, t] of prev) if (t.index < first - 6 || t.index > last + 6) { next.delete(k); changed = true }
      return changed ? next : prev
    })
  }, [first, last])

  const play = () => void transport().play().then(() => setPlaying(transport().playing))
  const pause = () => { transport().pause(); setPlaying(false); setTime(transport().time) }
  const seek = (t: number) => { transport().seek(t); setTime(transport().time) }
  const pick = (s: Side) => { transport().setSide(s); setWhich(s) }
  const moveWindow = (start: number) => onWinStart(Math.round(Math.min(maxStart, Math.max(0, start)) * 10) / 10)
  const setMode = (m: Mode) => {
    if (m === mode) return
    lastMode = m
    if (m === 'loop') {   // the window opens around wherever continuous playback has got to
      const t = transport().time
      const start = Math.round(Math.min(maxStart, Math.max(0, t - WINDOW / 2)) * 10) / 10
      onWinStart(start)
      winRef.current = start
    }
    setModeState(m)
  }
  // continuous mode: wheel and dragging seek; coalesce bursts so a trackpad doesn't restart playback 60 times a second
  const pendingSeek = useRef<{ to: number; timer: number } | null>(null)
  const seekSoon = (to: number) => {
    const clamped = Math.min(Math.max(0, to), Number.isFinite(durRef.current) ? durRef.current - 0.05 : to)
    if (pendingSeek.current) { pendingSeek.current.to = clamped; return }
    pendingSeek.current = { to: clamped, timer: window.setTimeout(() => { const p = pendingSeek.current; pendingSeek.current = null; if (p) seek(p.to) }, 60) }
  }
  const seekBase = () => pendingSeek.current?.to ?? transport().time
  const onWheel = (e: React.WheelEvent) => {
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
    if (!d) return
    if (modeRef.current === 'continuous') seekSoon(seekBase() + d * 0.05)
    else moveWindow(winStart + d * 0.05)
  }
  const onLaneSeek = useCallback((frac: number) => { const to = dispRef.current + frac * WINDOW; if (modeRef.current === 'continuous') seekSoon(to); else seek(to) }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  const onPickOriginal = useCallback(() => pick('original'), [])  // eslint-disable-line react-hooks/exhaustive-deps
  const onPickProcessed = useCallback(() => pick('processed'), [])  // eslint-disable-line react-hooks/exhaustive-deps
  const onOverviewMove = useCallback((start: number) => moveWindow(start), [maxStart])  // eslint-disable-line react-hooks/exhaustive-deps
  const onOverviewSeek = useCallback((to: number) => seekSoon(to), [])  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      const step = e.shiftKey ? 30 : 5
      if (e.key === ' ') { e.preventDefault(); playing ? pause() : play() }
      else if (e.key.toLowerCase() === 's') pick(which === 'original' ? 'processed' : 'original')
      else if (e.key === 'ArrowLeft') { if (mode === 'continuous') seekSoon(seekBase() - step); else moveWindow(winStart - step) }
      else if (e.key === 'ArrowRight') { if (mode === 'continuous') seekSoon(seekBase() + step); else moveWindow(winStart + step) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })  // eslint-disable-line react-hooks/exhaustive-deps

  const gen = genRef.current
  const ready = { processed: 0, original: 0, stale: 0 }
  for (let i = first; i <= last; i++) {
    const p = tiles.get(tileKey('processed', i)), o = tiles.get(tileKey('original', i))
    if (p) { if (p.gen === gen) ready.processed++; else ready.stale++ }
    if (o) ready.original++
  }
  const total = Math.max(0, last - first + 1)
  const cur = tiles.get(tileKey('processed', Math.min(last, Math.max(first, playIndex))))
  const refGain = refGainRef.current
  const procLufs = cur ? cur.lufs + (refGain === null ? 0 : refGain - cur.gainDb) : null
  const firstFailure = [...failed.current.entries()].find(([k]) => { const i = Number(k.split(':')[1]); return i >= first && i <= last })
  const ofDuration = Number.isFinite(duration) ? ` of ${fmtTime(duration)}` : ''

  return (
    <div className="rounded-xl border border-border bg-surface">
      <div className="border-b border-border px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={playing ? pause : play} className="w-24 shrink-0 justify-center">{playing ? <Pause size={14} /> : <Play size={14} />} {playing ? 'Pause' : 'Play'}</Button>
          <Segmented label="Which side you hear" value={which} onChange={pick} options={[{ value: 'original', label: 'Original' }, { value: 'processed', label: 'Processed' }]} />
          <Segmented label="Playback mode" value={mode} onChange={setMode} options={[
            { value: 'loop', label: <><Repeat size={13} /> Loop</>, title: 'Loop: play the 45 s window over and over; the needle moves across a fixed waveform' },
            { value: 'continuous', label: <><ChevronsRight size={13} /> Continuous</>, title: 'Continuous: play on through the recording; the needle stays in the middle and the waveform scrolls under it (near the start and end the needle moves instead)' },
          ]} />
          <label className="inline-flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg border border-border px-2.5 text-xs text-muted" title="Off: the original plays exactly as recorded. On: the original is turned up or down by one fixed amount so it is as loud as the processed side — louder always sounds better, so this lets you judge tone and noise alone. Measured on the chunks around the view. Only affects what you hear here; the final clip is not changed.">
            <Switch checked={matchLoudness} onChange={setMatchLoudness} label="Match loudness" /> Match loudness
            {matchLoudness && <span className="tabular-nums text-text">{matchDb === null ? '…' : db(matchDb)}</span>}
          </label>
          <span className="ml-auto inline-flex h-8 shrink-0 items-center text-muted" title={mode === 'loop' ? 'Space play / pause · S switch side · click a lane to jump · ← → move the window 5 s (shift: 30 s) · scroll over the lanes to move the window · drag the window on the overview' : 'Space play / pause · S switch side · click a lane to jump · ← → jump 5 s (shift: 30 s) · scroll over the lanes to scrub · click or drag on the overview to jump'}><Keyboard size={15} /></span>
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[11px] text-muted">
          <span className="inline-flex items-center gap-1 tabular-nums">
            {ready.processed < total && lookOk ? <><Spinner className="text-accent" /> {ready.processed} of {total} chunks ready{ready.stale ? ` · ${ready.stale} from the previous settings playing` : ''}</> : <span className="text-muted/70">all {total} chunks in view ready</span>}
          </span>
          <span className="tabular-nums">{mode === 'loop' ? `${fmtTime(time)} · window ${fmtTime(winStart)}–${fmtTime(winStart + WINDOW)}${ofDuration}` : `${fmtTime(time)}${ofDuration}`}</span>
        </div>
      </div>
      <div className="px-4 py-3 space-y-2" onWheel={onWheel}>
        <Lane label="Original" kind="original" tiles={tiles} gen={gen} active={which === 'original'} anchor={anchor} duration={duration} register={register} onSeekFrac={onLaneSeek} onPick={onPickOriginal} />
        <Lane label="Processed" kind="processed" tiles={tiles} gen={gen} active={which === 'processed'} anchor={anchor} duration={duration} register={register} onSeekFrac={onLaneSeek} onPick={onPickProcessed} />
        <TimeStrip anchor={anchor} duration={duration} register={register} />
        <Overview overview={overview} mode={mode} register={register} getWinStart={() => winRef.current} onMove={onOverviewMove} onSeek={onOverviewSeek} />
      </div>
      <div className="@container border-t border-border px-4 py-3 text-xs"><div className="grid grid-cols-2 gap-x-6 gap-y-3 @lg:grid-cols-4">
        <Stat label="Processed" value={procLufs !== null && Number.isFinite(procLufs) ? `${procLufs.toFixed(1)} LUFS` : '—'} hint="at the playhead" />
        <Stat label="Original" value={overview && Number.isFinite(overview.lufs) ? `${overview.lufs.toFixed(1)} LUFS` : '—'} hint={matchLoudness && matchDb !== null ? `whole recording · heard ${db(matchDb)}` : 'whole recording'} />
        <Stat label="Levelling gain" value={refGain === null ? '—' : db(refGain)} hint="loudness levelling" />
        <Stat label="Output" value={cur ? (cur.channels === 2 ? 'stereo' : 'mono') : '—'} hint={cur?.channels === 2 ? 'reverb makes it stereo' : 'processed side'} />
        </div>
        {cur && cur.warnings.length > 0 && <div className="mt-2 flex items-center gap-1 text-[11px] text-warn"><AlertTriangle size={12} /> {cur.warnings.join(' · ')}</div>}
        {firstFailure && <div className="mt-2 flex items-center gap-1 text-[11px] text-warn"><AlertTriangle size={12} /> A chunk could not be rendered: {firstFailure[1]}</div>}
      </div>
    </div>
  )
}

/** Measures an element's width and keeps it current. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = ref.current; if (!el) return
    setW(el.clientWidth)
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

/**
 * One waveform lane. The canvas holds a strip three windows wide starting at `anchor` and is drawn only when
 * chunks or the anchor change; every animation frame it is slid so `viewStart` sits at the left edge, and the
 * needle is placed at the playhead (in continuous mode the middle, except near the start and end of the recording).
 */
const Lane = memo(function Lane({ label, kind, tiles, gen, active, anchor, duration, register, onSeekFrac, onPick }: {
  label: string; kind: Side; tiles: Map<string, Loaded>; gen: number; active: boolean; anchor: number; duration: number
  register: (p: Placer) => () => void; onSeekFrac: (frac: number) => void; onPick: () => void
}) {
  const [boxRef, cw] = useWidth<HTMLDivElement>()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const needleRef = useRef<HTMLDivElement>(null)
  const drawnAnchor = useRef(anchor)
  useEffect(() => {
    const c = canvasRef.current; if (!c || !cw) return
    const dpr = window.devicePixelRatio || 1
    const w = cw * 3, h = c.clientHeight
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr) }
    c.style.width = `${w}px`
    const ctx = c.getContext('2d'); if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    const cs = getComputedStyle(c)
    const colour = active ? cs.getPropertyValue('--accent').trim() || '#6366f1' : cs.getPropertyValue('--muted').trim() || '#64748b'
    const mid = h / 2, pxPerSec = cw / WINDOW
    const lastIdx = Number.isFinite(duration) ? Math.ceil(duration / TILE) - 1 : Infinity
    const firstI = Math.max(0, Math.floor(anchor / TILE)), lastI = Math.min(lastIdx, Math.floor((anchor + 3 * WINDOW) / TILE))
    for (let i = firstI; i <= lastI; i++) {
      const t = tiles.get(tileKey(kind, i))
      const x0 = (i * TILE - anchor) * pxPerSec
      const tw = (Math.min(TILE, Number.isFinite(duration) ? duration - i * TILE : TILE)) * pxPerSec
      if (!t) {   // not rendered yet: hatched
        ctx.save(); ctx.beginPath(); ctx.rect(x0, 0, tw, h); ctx.clip()
        ctx.strokeStyle = colour; ctx.globalAlpha = 0.15; ctx.lineWidth = 1
        for (let x = x0 - h; x < x0 + tw; x += 8) { ctx.beginPath(); ctx.moveTo(x, h); ctx.lineTo(x + h, 0); ctx.stroke() }
        ctx.restore(); continue
      }
      const stale = kind === 'processed' && t.gen !== gen
      ctx.fillStyle = colour
      ctx.globalAlpha = (active ? 0.95 : 0.55) * (stale ? 0.45 : 1)
      const n = t.peaks.length / 2, bw = (TILE * pxPerSec) / n
      for (let b = 0; b < n; b++) {
        const x = x0 + b * bw
        if (x - x0 > tw) break
        const min = t.peaks[b * 2]!, max = t.peaks[b * 2 + 1]!
        const y1 = mid - max * (mid - 1), y2 = mid - min * (mid - 1)
        ctx.fillRect(x, y1, Math.max(1, bw), Math.max(1, y2 - y1))
      }
    }
    ctx.globalAlpha = 1
    drawnAnchor.current = anchor
  }, [tiles, gen, kind, active, anchor, duration, cw])
  useEffect(() => register((viewStart, time) => {
    const c = canvasRef.current, n = needleRef.current
    if (!c || !n || !cw) return
    c.style.transform = `translate3d(${(-(viewStart - drawnAnchor.current) / WINDOW) * cw}px,0,0)`
    const frac = (time - viewStart) / WINDOW
    n.style.transform = `translate3d(${frac * cw}px,0,0)`
    n.style.opacity = frac < 0 || frac > 1 ? '0' : '1'
  }), [register, cw])
  return (
    <div ref={boxRef} className={clsx('relative h-24 overflow-hidden rounded-lg border', active ? 'border-accent/50 bg-accent/5' : 'border-border bg-surface-2/40')}>
      <canvas ref={canvasRef} className="absolute inset-y-0 left-0 h-full cursor-crosshair will-change-transform"
        onClick={(e) => { const r = boxRef.current!.getBoundingClientRect(); onSeekFrac((e.clientX - r.left) / r.width) }} />
      <div ref={needleRef} className="pointer-events-none absolute inset-y-0 left-0 w-px bg-text will-change-transform" />
      <button type="button" onClick={onPick} className={clsx('absolute left-2 top-1.5 z-10 rounded px-1.5 text-[10.5px] no-drag', active ? 'bg-accent text-white' : 'bg-surface text-muted hover:text-text')}>{label}{active ? ' · playing' : ''}</button>
    </div>
  )
})

/** Time labels on the same three-window strip as the lanes, slid with them. */
const TimeStrip = memo(function TimeStrip({ anchor, duration, register }: { anchor: number; duration: number; register: (p: Placer) => () => void }) {
  const [boxRef, cw] = useWidth<HTMLDivElement>()
  const stripRef = useRef<HTMLDivElement>(null)
  const drawnAnchor = useRef(anchor)
  drawnAnchor.current = anchor
  const ticks: number[] = []
  for (let t = Math.ceil(anchor / 5) * 5; t <= anchor + 3 * WINDOW; t += 5) if (t >= 0 && (!Number.isFinite(duration) || t <= duration)) ticks.push(t)
  useEffect(() => register((viewStart) => {
    const s = stripRef.current; if (!s || !cw) return
    s.style.transform = `translate3d(${(-(viewStart - drawnAnchor.current) / WINDOW) * cw}px,0,0)`
  }), [register, cw])
  return (
    <div ref={boxRef} className="relative h-4 overflow-hidden text-[10px] tabular-nums text-muted">
      <div ref={stripRef} className="absolute inset-y-0 left-0 will-change-transform" style={{ width: cw * 3 }}>
        {ticks.map((t) => <span key={t} className="absolute -translate-x-1/2" style={{ left: ((t - anchor) / WINDOW) * cw }}>{fmtTime(t)}</span>)}
      </div>
    </div>
  )
})

/**
 * The whole recording with the view on it. Loop mode: drag the window, or click to centre it there.
 * Continuous mode: click or drag to jump; the view follows the playhead.
 */
const Overview = memo(function Overview({ overview, mode, register, getWinStart, onMove, onSeek }: {
  overview: AudioOverview | null; mode: Mode; register: (p: Placer) => () => void; getWinStart: () => number
  onMove: (start: number) => void; onSeek: (to: number) => void
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const boxRef = useRef<HTMLDivElement>(null), needleRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ grabOffset: number } | null>(null)
  const dur = overview?.durationSec ?? 0
  useEffect(() => {
    const c = ref.current; if (!c) return
    const draw = () => {
      const dpr = window.devicePixelRatio || 1
      const w = c.clientWidth, h = c.clientHeight
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr) }
      const ctx = c.getContext('2d'); if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      if (!overview) return
      const muted = getComputedStyle(c).getPropertyValue('--muted').trim() || '#64748b'
      const n = overview.peaks.length / 2, mid = h / 2
      ctx.fillStyle = muted; ctx.globalAlpha = 0.6
      for (let i = 0; i < n; i++) { const x = (i / n) * w; const min = overview.peaks[i * 2]!, max = overview.peaks[i * 2 + 1]!; ctx.fillRect(x, mid - max * (mid - 1), Math.max(1, w / n), Math.max(1, (max - min) * (mid - 1))) }
      ctx.globalAlpha = 1
    }
    draw()
    const ro = new ResizeObserver(draw); ro.observe(c)
    return () => ro.disconnect()
  }, [overview])
  useEffect(() => register((viewStart, time) => {
    const b = boxRef.current, n = needleRef.current
    if (!b || !n || !dur) return
    b.style.left = `${(viewStart / dur) * 100}%`; b.style.width = `${(WINDOW / dur) * 100}%`
    n.style.left = `${Math.min(100, Math.max(0, (time / dur) * 100))}%`
  }), [register, dur])
  const secAt = (e: React.PointerEvent) => { const r = e.currentTarget.getBoundingClientRect(); return Math.min(dur, Math.max(0, ((e.clientX - r.left) / r.width) * dur)) }
  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dur) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const s = secAt(e)
    if (mode === 'continuous') { drag.current = { grabOffset: 0 }; onSeek(s); return }
    const ws = getWinStart(), inside = s >= ws && s <= ws + WINDOW
    drag.current = { grabOffset: inside ? s - ws : WINDOW / 2 }
    onMove(s - drag.current.grabOffset)
  }
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drag.current || !dur) return
    if (mode === 'continuous') onSeek(secAt(e)); else onMove(secAt(e) - drag.current.grabOffset)
  }
  return (
    <div className="pt-1">
    <div className="mb-1 flex items-center justify-between gap-3 text-[10.5px] text-muted">
      <span>Whole recording</span>
      <span>{mode === 'loop' ? 'drag the window to move it' : 'click or drag to jump'}</span>
    </div>
    <div className="relative">
      <canvas ref={ref} className={clsx('block h-10 w-full rounded-md border border-border bg-surface-2/40', dur ? (mode === 'loop' ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer') : '')}
        onPointerDown={down} onPointerMove={move} onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }} />
      {dur > 0 && <div ref={boxRef} className="pointer-events-none absolute inset-y-0 rounded-sm border-[1.5px] border-accent/90 bg-accent/18" />}
      {dur > 0 && <div ref={needleRef} className="pointer-events-none absolute inset-y-0 w-px bg-text" />}
      {!overview && <div className="absolute inset-0 flex items-center justify-center text-[11px] text-muted"><Spinner className="mr-1 text-accent" /> reading the whole recording…</div>}
    </div>
    </div>
  )
})
