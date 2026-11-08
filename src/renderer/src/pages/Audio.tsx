import { clsx } from 'clsx'
import { AlertTriangle, AudioLines, Pause, Play, Repeat, RotateCcw, Save, Undo2, Waves } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AudioAnalysis, AudioLook, AudioOverview } from '@shared/types'
import { EQ_BANDS, KNOBS, MODULE_ORDER, MODULE_TITLES, SIGNAL_FLOW, countOn, defaultModules, fromLook, toLook, type EqState, type Knob, type ModuleKey, type Modules, type StripKey } from '@core/audio-modules'
import { eqResponseDb, logFrequencies } from '@core/eq-response'
import { describeLook, validateLook } from '../../../plugins/audio/look'
import { Badge, Button, Select, Slider, Spinner, Switch, Empty } from '@/components/ui'
import { errText, useStore } from '@/store'

const audioUrl = (file: string) => `yj-audio://preview/?p=${encodeURIComponent(file)}`

// ── helpers ───────────────────────────────────────────────────────────────────

const fmtTime = (s: number) => { const m = Math.floor(s / 60), r = Math.floor(s - m * 60); return `${m}:${String(r).padStart(2, '0')}` }
const fmtNum = (v: number, step: number) => v.toFixed(Math.min(4, (String(step).split('.')[1] ?? '').length))
const db = (v: number, unit = 'dB') => `${v > 0 ? '+' : ''}${v.toFixed(1)} ${unit}`

// Log sliders move in 1000 steps between min and max; linear ones use the knob's own range.
const SLIDER_STEPS = 1000
const toPos = (k: { min: number; max: number; log?: boolean }, v: number) => k.log ? Math.round(((Math.log(Math.max(k.min, v)) - Math.log(k.min)) / (Math.log(k.max) - Math.log(k.min))) * SLIDER_STEPS) : v
const fromPos = (k: { min: number; max: number; step: number; log?: boolean }, p: number) => {
  if (!k.log) return p
  const raw = Math.exp(Math.log(k.min) + (p / SLIDER_STEPS) * (Math.log(k.max) - Math.log(k.min)))
  return Math.min(k.max, Math.max(k.min, Math.round(raw / k.step) * k.step))
}

// ── page ──────────────────────────────────────────────────────────────────────

export default function AudioPage() {
  const library = useStore((s) => s.library)
  const notify = useStore((s) => s.notify)
  const call = useStore((s) => s.call)
  const saving = useStore((s) => !!s.busy['audioLook'])
  const saved = library.audioLook
  const records = library.records
  const loaded = useMemo(() => fromLook(saved.look), [saved.look])
  const [modules, setModules] = useState<Modules>(() => loaded.modules)
  const [sample, setSample] = useState<{ recordId: string; start: number }>(() => saved.sample ?? { recordId: records[0]?.id ?? '', start: 60 })
  const [analysis, setAnalysis] = useState<AudioAnalysis | null>(null)
  const [analysing, setAnalysing] = useState(false)
  useEffect(() => { setAnalysis(null) }, [sample.recordId])
  useEffect(() => { if (!sample.recordId && records[0]) setSample((s) => ({ ...s, recordId: records[0]!.id })) }, [records, sample.recordId])

  const look: AudioLook = useMemo(() => toLook(modules), [modules])
  const validation = useMemo(() => validateLook(look), [look])
  const errors = validation.ok ? [] : validation.errors
  const savedLook = useMemo(() => toLook(loaded.modules), [loaded.modules])
  const dirty = JSON.stringify(look) !== JSON.stringify(savedLook) || JSON.stringify(sample) !== JSON.stringify(saved.sample ?? sample)
  const on = countOn(modules)
  const summary = validation.ok ? describeLook(validation.look) : 'fix the values marked below'
  const record = records.find((r) => r.id === sample.recordId)
  const setStart = (start: number) => setSample((s) => (Math.abs(s.start - start) < 0.01 ? s : { ...s, start }))

  const update = <K extends ModuleKey>(key: K, patch: Partial<Modules[K]>) => setModules((m) => ({ ...m, [key]: { ...m[key], ...patch } }))
  const strip = (key: StripKey) => modules[key] as Record<string, unknown> & { on: boolean }
  const save = () => void call('audioLook', async () => {
    await window.api.setAudioLook({ look, sample })
    notify('success', 'Audio look saved. Uploads still use the original audio for now.')
  })
  const discard = () => { setModules(loaded.modules); if (saved.sample) setSample(saved.sample) }
  const analyse = () => {
    if (!record) return
    setAnalysing(true)
    window.api.analyseAudio(record.id).then(setAnalysis).catch((e) => notify('error', errText(e))).finally(() => setAnalysing(false))
  }

  if (!records.length) {
    return (
      <div className="h-full overflow-auto">
        <div className="drag h-13 flex items-center px-6 border-b border-border"><h1 className="font-semibold">Audio</h1></div>
        <div className="p-6"><Empty icon={<AudioLines size={28} />} title="No recordings yet" hint="Add recordings to the library to shape their audio here." /></div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="drag h-13 flex shrink-0 items-center gap-3 border-b border-border px-6">
        <h1 className="font-semibold">Audio</h1>
        <span className="min-w-0 truncate text-xs text-muted" title={summary}>{summary}</span>
        <div className="no-drag ml-auto flex shrink-0 items-center gap-2">
          <Badge tone={on ? 'info' : 'muted'} className="whitespace-nowrap">{on ? `${on} module${on === 1 ? '' : 's'} on` : 'no processing'}</Badge>
          <Button size="sm" variant="ghost" disabled={!on} onClick={() => setModules(defaultModules())} title="Switch every module off and return every knob to its default"><RotateCcw size={13} /> Reset all</Button>
          <Button size="sm" variant="ghost" disabled={!dirty || saving} onClick={discard}><Undo2 size={13} /> Discard</Button>
          <Button size="sm" disabled={!dirty || saving || errors.length > 0} onClick={save}><Save size={13} /> {saving ? 'Saving…' : 'Save look'}</Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        {/* left: the channel strip, simplest module first */}
        <aside className="w-[420px] shrink-0 overflow-y-auto border-r border-border">
          <div className="border-b border-border px-4 py-3 text-[11px] leading-snug text-muted">
            <div><span className="font-medium text-text">Signal flow:</span> {SIGNAL_FLOW}.</div>
            <div className="mt-1">Every knob is a raw ffmpeg setting shown in studio units; the EQ sits under the waveforms. Editor only for now: uploads keep the original audio.</div>
            {loaded.unmapped.length > 0 && <div className="mt-1 text-warn">The saved look had steps this strip can’t show and they were dropped: {loaded.unmapped.join(', ')}.</div>}
          </div>
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
        </aside>

        {/* right: sample + A/B player + EQ */}
        <main className="min-w-0 flex-1 overflow-y-auto p-5 space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="min-w-0 flex-1 text-xs text-muted">
              <div className="mb-1">Recording to listen to</div>
              <Select value={sample.recordId} onChange={(e) => setSample({ recordId: e.target.value, start: 60 })} className="h-8 w-full text-[13px]">
                {records.map((r) => <option key={r.id} value={r.id}>{r.reciterFolder ? `${r.reciterFolder} / ` : ''}{r.fileName}</option>)}
              </Select>
            </label>
            <Button size="sm" variant="ghost" disabled={!record || analysing} onClick={analyse} title="Measure the whole recording: loudness, peaks, hiss, rumble, clipping"><Waves size={13} /> {analysing ? 'Analysing…' : analysis ? 'Re-analyse' : 'Analyse recording'}</Button>
          </div>
          {analysis && (
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-xl border border-border bg-surface px-4 py-3 text-xs sm:grid-cols-4">
              <Stat label="Length" value={fmtTime(analysis.durationSec)} />
              <Stat label="Loudness" value={`${analysis.lufs.toFixed(1)} LUFS`} hint={`range ${analysis.lra.toFixed(1)} LU`} />
              <Stat label="True peak" value={db(analysis.truePeak, 'dBTP')} hint={analysis.clipped ? 'clipped' : `${analysis.hotSamplesPct.toFixed(3)} % hot`} tone={analysis.clipped ? 'err' : undefined} />
              <Stat label="Hiss / rumble" value={`${analysis.hissDb.toFixed(0)} / ${analysis.rumbleDb.toFixed(0)} dB`} hint="relative to the voice; lower is cleaner" />
              {analysis.hints.length > 0 && <div className="col-span-full mt-1 text-[11px] text-muted">{analysis.hints.join(' · ')}</div>}
            </div>
          )}
          {errors.length > 0 && (
            <div className="rounded-xl border border-err/40 bg-err/6 px-4 py-3 text-xs"><b>The plugin rejects some values:</b> {errors.map((e) => `${e.path}: ${e.message}`).join(' · ')}</div>
          )}
          {!record ? <Empty icon={<AudioLines size={28} />} title="Choose a recording" />
            : <Workbench key={record.id} recordId={record.id} look={look} lookOk={validation.ok} winStart={sample.start} onWinStart={setStart} />}
          <EqEditor eq={modules.eq} onChange={(eq) => setModules((m) => ({ ...m, eq }))} />
        </main>
      </div>
    </div>
  )
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'err' }) {
  return (
    <div>
      <div className="text-[11px] text-muted">{label}</div>
      <div className={clsx('tabular-nums', tone === 'err' && 'text-err')}>{value}</div>
      {hint && <div className="text-[10.5px] text-muted">{hint}</div>}
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
  }, [eq, selected, freqs])

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
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <div className="text-[13px] font-medium">Equaliser</div>
        <span className="text-[11px] text-muted">drag a point for frequency and gain (pass filters: up/down for Q) · scroll on the curve for the selected band’s Q · ffmpeg highpass, lowshelf, equalizer ×{EQ_BANDS}, highshelf, lowpass</span>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => onChange(defaultModules().eq)} title="All bands off and back to their defaults"><RotateCcw size={13} /> Reset EQ</Button>
          <Switch checked={eq.on} onChange={(on) => onChange({ ...eq, on })} label="Equaliser" />
        </div>
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
      <div className={clsx('grid grid-cols-1 gap-x-6 gap-y-3 border-t border-border px-4 py-3 sm:grid-cols-3', !eq.on && 'opacity-60')}>
        <div className="sm:col-span-3 flex items-center gap-3">
          <span className="inline-block h-3 w-3 rounded-full" style={{ background: node.colour }} />
          <span className="text-[13px] font-medium">{node.label}</span>
          <span className="text-[11px] text-muted">{selected === 'hp' ? 'Removes everything below the frequency, 12 dB per octave. Q 0.707 is flat; higher adds a bump at the corner.' : selected === 'lp' ? 'Removes everything above the frequency, 12 dB per octave.' : selected === 'ls' ? 'Raises or lowers everything below the frequency.' : selected === 'hs' ? 'Raises or lowers everything above the frequency.' : 'Boosts or cuts a band around the frequency; Q sets how narrow the band is.'}</span>
          <label className="ml-auto inline-flex items-center gap-2 text-xs text-muted"><Switch checked={sel.on} onChange={(v) => onChange(withNode(eq, selected, { on: v }))} label={`${node.label} on`} /> on</label>
        </div>
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
    const endAt = base + t.index * TILE + TILE + post
    let at = begin, offset = t.offset - pre, ramp = pre + JOIN   // natural join: ramp over the overlap
    if (begin < ref) { const skip = ref - begin; offset += skip; at = ref; ramp = fadeIn }   // entering mid-chunk
    const dur = endAt - at
    if (dur <= 0.01) return
    const src = this.ctx.createBufferSource(); src.buffer = t.buffer
    const gain = this.ctx.createGain(), mute = this.ctx.createGain()
    const g = this.compensation(t)
    if (ramp > 0) { gain.gain.setValueAtTime(0, at); gain.gain.linearRampToValueAtTime(g, at + ramp) } else gain.gain.setValueAtTime(g, at)
    if (endAt - (post + JOIN) > at + ramp) { gain.gain.setValueAtTime(g, endAt - (post + JOIN)); gain.gain.linearRampToValueAtTime(0, endAt) }
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

  private startLap(base: number, ref: number, fadeIn: number): Map<string, Voice> {
    const into = new Map<string, Voice>()
    for (const t of this.tiles.values()) if (this.inWindow(t)) this.schedule(t, into, base, ref, fadeIn)
    return into
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
      const ref = this.ctx.currentTime + LEAD
      for (const t of next.values()) {
        if (!this.inWindow(t)) continue
        const live = this.voices.get(t.key)
        if (live && live.tile === t) continue
        if (live) this.stop(live, XFADE)
        this.schedule(t, this.voices, this.startedAt, ref, live ? XFADE : ENTER)
      }
    }
    this.tiles = next
  }

  setWindow(start: number): void {
    this.win = { start, end: start + WINDOW }
    if (this.time < start || this.time >= start + WINDOW) this.seek(start)
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
    if (this.lap && now >= this.lap.at) { this.log(`commit lap (late by ${(now - this.lap.at).toFixed(3)})`); this.startedAt = this.lap.startedAt; this.voices = this.lap.voices; this.lap = null; return }
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
  const [loop, setLoop] = useState(true)
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

  // look changed → new generation: processed chunks become stale (kept playing until replaced), old renders cancelled
  useEffect(() => {
    genRef.current = Math.max(genRef.current + 1, Date.now())
    refGainRef.current = null
    transport().setRefGain(null)
    for (const k of [...failed.current.keys()]) if (k.startsWith('processed:')) failed.current.delete(k)
    void window.api.cancelAudioTiles(genRef.current, recordId)
    setTick((n) => n + 1)
  }, [lookKey])  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { transport().setWindow(winStart); setTime(transport().time) }, [winStart])  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { transport().setTiles(tiles) }, [tiles])  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const t = transport()
    const target = look.level ? look.level.lufs : null
    t.setOriginalGain(matchLoudness && overview && target !== null && Number.isFinite(overview.lufs) ? Math.pow(10, (target - overview.lufs) / 20) : 1)
  }, [matchLoudness, overview, lookKey])  // eslint-disable-line react-hooks/exhaustive-deps

  // Scheduler: which chunks the window needs, nearest to the playhead first, then ahead, then behind.
  const first = Math.floor(winStart / TILE), last = Math.floor((winStart + WINDOW - 0.001) / TILE)
  const playIndex = Math.floor(time / TILE)
  useEffect(() => {
    if (!lookOk) return
    const centre = Math.min(last, Math.max(first, playIndex))
    const order: number[] = [centre]
    for (let d = 1; order.length < last - first + 1; d++) { if (centre + d <= last) order.push(centre + d); if (centre - d >= first) order.push(centre - d) }
    const gen = genRef.current
    const want: { kind: Side; index: number }[] = []
    for (const index of order) {
      if (Number.isFinite(duration) && index * TILE >= duration) continue
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
          const loaded: Loaded = { key, kind: w.kind, index: w.index, gen, buffer, offset: r.tile.offset, peaks: r.tile.peaks, gainDb: r.tile.gainDb, lufs: r.tile.lufs, truePeak: r.tile.truePeak, channels: r.tile.channels, warnings: r.tile.warnings }
          if (w.kind === 'processed' && refGainRef.current === null) { refGainRef.current = r.tile.gainDb; transport().setRefGain(r.tile.gainDb) }
          setTiles((prev) => { const next = new Map(prev); next.set(key, loaded); return next })
        })
        .catch((e) => failed.current.set(key, errText(e)))
        .finally(() => { inflight.current.delete(key); setTick((n) => n + 1) })
    }
  }, [recordId, lookKey, lookOk, first, last, playIndex, tiles, tick, duration])  // eslint-disable-line react-hooks/exhaustive-deps

  // Display clock + loop at the window end; drop chunks far outside the window to keep memory bounded.
  useEffect(() => {
    let raf = 0, last = 0
    const step = (now: number) => {
      const t = transport(); t.tick()
      if (now - last > 33) { last = now; setTime(t.time); if (!t.playing) setPlaying(false) }   // ~30 fps is plenty for a playhead; the waveforms themselves never redraw for time
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
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
  const toggleLoop = () => setLoop((l) => { transport().setLoop(!l); return !l })
  const moveWindow = (start: number) => onWinStart(Math.round(Math.min(maxStart, Math.max(0, start)) * 10) / 10)
  const onWheel = (e: React.WheelEvent) => { const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY; if (d) moveWindow(winStart + d * 0.05) }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      if (e.key === ' ') { e.preventDefault(); playing ? pause() : play() }
      else if (e.key.toLowerCase() === 's') pick(which === 'original' ? 'processed' : 'original')
      else if (e.key === 'ArrowLeft') moveWindow(winStart - (e.shiftKey ? 30 : 5))
      else if (e.key === 'ArrowRight') moveWindow(winStart + (e.shiftKey ? 30 : 5))
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
  const total = last - first + 1
  const cur = tiles.get(tileKey('processed', Math.min(last, Math.max(first, playIndex))))
  const refGain = refGainRef.current
  const procLufs = cur ? cur.lufs + (refGain === null ? 0 : refGain - cur.gainDb) : null
  const firstFailure = [...failed.current.entries()].find(([k]) => { const i = Number(k.split(':')[1]); return i >= first && i <= last })

  return (
    <div className="rounded-xl border border-border bg-surface">
      <div className="border-b border-border px-4 py-2.5">
        <div className="flex h-8 items-center gap-2 whitespace-nowrap">
          <Button size="sm" onClick={playing ? pause : play} className="w-24 shrink-0 justify-center">{playing ? <Pause size={14} /> : <Play size={14} />} {playing ? 'Pause' : 'Play'}</Button>
          <div className="inline-flex shrink-0 overflow-hidden rounded-lg border border-border text-xs">
            {(['original', 'processed'] as const).map((w) => (
              <button key={w} type="button" onClick={() => pick(w)} className={clsx('px-3 h-8 no-drag transition-colors', which === w ? 'bg-accent/15 text-accent font-medium' : 'text-muted hover:text-text')}>{w === 'original' ? 'Original' : 'Processed'}</button>
            ))}
          </div>
          <button type="button" onClick={toggleLoop} className={clsx('inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border px-2.5 text-xs no-drag', loop ? 'border-accent/40 text-accent bg-accent/10' : 'border-border text-muted')} title="Loop the window"><Repeat size={13} /> Loop</button>
          <label className="inline-flex h-8 shrink-0 items-center gap-2 rounded-lg border border-border px-2.5 text-xs text-muted" title="Off: the original plays exactly as recorded. On: the original gets one fixed gain so it sits at the levelling target — louder never sounds better, so you judge tone and noise alone. Needs Loudness levelling on. The final clip is not affected either way.">
            <Switch checked={matchLoudness} onChange={setMatchLoudness} label="Match loudness" disabled={!overview || !look.level} /> Match
          </label>
          <span className="ml-auto min-w-0 truncate text-[11px] text-muted" title="Space = play/pause · S = switch side · ←/→ move the window 5 s (shift: 30 s) · scroll over the lanes to move · drag the window on the overview">Space · S · ←/→ · scroll · drag</span>
        </div>
        <div className="mt-1.5 flex h-4 items-center gap-3 whitespace-nowrap text-[11px] text-muted">
          <span className="inline-flex min-w-0 flex-1 items-center gap-1 truncate tabular-nums">
            {ready.processed < total && lookOk ? <><Spinner className="text-accent" /> {ready.processed}/{total} chunks{ready.stale ? ` · ${ready.stale} from the previous settings playing` : ''}</> : <span className="text-muted/70">all {total} chunks ready</span>}
          </span>
          <span className="shrink-0 tabular-nums">{fmtTime(time)} · window {fmtTime(winStart)}–{fmtTime(winStart + WINDOW)}{Number.isFinite(duration) ? ` of ${fmtTime(duration)}` : ''}</span>
        </div>
      </div>
      <div className="px-4 py-3 space-y-2" onWheel={onWheel}>
        <Lane label="Original" kind="original" tiles={tiles} gen={gen} active={which === 'original'} time={time} winStart={winStart} onSeek={seek} onPick={() => pick('original')} />
        <Lane label="Processed" kind="processed" tiles={tiles} gen={gen} active={which === 'processed'} time={time} winStart={winStart} onSeek={seek} onPick={() => pick('processed')} />
        <TimeAxis startOffset={winStart} duration={WINDOW} />
        <Overview overview={overview} winStart={winStart} time={time} onMove={moveWindow} />
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 border-t border-border px-4 py-3 text-xs sm:grid-cols-4">
        <Stat label="Processed loudness" value={procLufs !== null && Number.isFinite(procLufs) ? `${procLufs.toFixed(1)} LUFS` : '—'} hint="at the playhead, all chunks at one gain" />
        <Stat label="Original loudness" value={overview && Number.isFinite(overview.lufs) ? `${overview.lufs.toFixed(1)} LUFS` : '—'} hint={matchLoudness ? 'raised to the target while matching' : 'whole recording, as recorded'} />
        <Stat label="Gain applied" value={refGain === null ? '—' : db(refGain)} hint="by the loudness stage" />
        <Stat label="Channels" value={cur ? (cur.channels === 2 ? 'stereo' : 'mono') : '—'} hint={cur?.channels === 2 ? 'reverb makes it stereo' : undefined} />
        {cur && cur.warnings.length > 0 && <div className="col-span-full flex items-center gap-1 text-[11px] text-warn"><AlertTriangle size={12} /> {cur.warnings.join(' · ')}</div>}
        {firstFailure && <div className="col-span-full flex items-center gap-1 text-[11px] text-warn"><AlertTriangle size={12} /> A chunk could not be rendered: {firstFailure[1]}</div>}
      </div>
    </div>
  )
}

function Lane({ label, kind, tiles, gen, active, time, winStart, onSeek, onPick }: { label: string; kind: Side; tiles: Map<string, Loaded>; gen: number; active: boolean; time: number; winStart: number; onSeek: (t: number) => void; onPick: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {   // waveform only — not on every playhead move
    const c = ref.current; if (!c) return
    const dpr = window.devicePixelRatio || 1
    const w = c.clientWidth, h = c.clientHeight
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr) }
    const ctx = c.getContext('2d'); if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    const cs = getComputedStyle(c)
    const colour = active ? cs.getPropertyValue('--accent').trim() || '#6366f1' : cs.getPropertyValue('--muted').trim() || '#64748b'
    const mid = h / 2, pxPerSec = w / WINDOW
    const first = Math.floor(winStart / TILE), last = Math.floor((winStart + WINDOW - 0.001) / TILE)
    for (let i = first; i <= last; i++) {
      const t = tiles.get(tileKey(kind, i))
      const x0 = (i * TILE - winStart) * pxPerSec, tw = TILE * pxPerSec
      if (!t) {   // not rendered yet: hatched
        ctx.save(); ctx.beginPath(); ctx.rect(Math.max(0, x0), 0, Math.min(w, x0 + tw) - Math.max(0, x0), h); ctx.clip()
        ctx.strokeStyle = colour; ctx.globalAlpha = 0.15; ctx.lineWidth = 1
        for (let x = x0 - h; x < x0 + tw; x += 8) { ctx.beginPath(); ctx.moveTo(x, h); ctx.lineTo(x + h, 0); ctx.stroke() }
        ctx.restore(); continue
      }
      const stale = kind === 'processed' && t.gen !== gen
      ctx.fillStyle = colour
      ctx.globalAlpha = (active ? 0.95 : 0.55) * (stale ? 0.45 : 1)
      const n = t.peaks.length / 2, bw = tw / n
      for (let b = 0; b < n; b++) {
        const x = x0 + b * bw
        if (x + bw < 0 || x > w) continue
        const min = t.peaks[b * 2]!, max = t.peaks[b * 2 + 1]!
        const y1 = mid - max * (mid - 1), y2 = mid - min * (mid - 1)
        ctx.fillRect(x, y1, Math.max(1, bw), Math.max(1, y2 - y1))
      }
    }
    ctx.globalAlpha = 1
  }, [tiles, gen, kind, active, winStart])
  const pct = Math.min(100, Math.max(0, ((time - winStart) / WINDOW) * 100))
  return (
    <div className={clsx('relative rounded-lg border', active ? 'border-accent/50 bg-accent/5' : 'border-border bg-surface-2/40')}>
      <button type="button" onClick={onPick} className={clsx('absolute left-2 top-1.5 z-10 rounded px-1.5 text-[10.5px] no-drag', active ? 'bg-accent text-white' : 'bg-surface text-muted hover:text-text')}>{label}{active ? ' · playing' : ''}</button>
      <canvas ref={ref} className="block h-24 w-full cursor-crosshair"
        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); onSeek(winStart + ((e.clientX - r.left) / r.width) * WINDOW) }} />
      <div className="pointer-events-none absolute inset-y-0 w-px bg-text" style={{ left: `${pct}%` }} />
    </div>
  )
}

/** The whole recording with the window on it: drag the window, click to centre it there. */
function Overview({ overview, winStart, time, onMove }: { overview: AudioOverview | null; winStart: number; time: number; onMove: (start: number) => void }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const drag = useRef<{ grabOffset: number } | null>(null)
  const dur = overview?.durationSec ?? 0
  useEffect(() => {
    const c = ref.current; if (!c) return
    const dpr = window.devicePixelRatio || 1
    const w = c.clientWidth, h = c.clientHeight
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr) }
    const ctx = c.getContext('2d'); if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    const cs = getComputedStyle(c)
    const muted = cs.getPropertyValue('--muted').trim() || '#64748b', accent = cs.getPropertyValue('--accent').trim() || '#6366f1'
    if (!overview) return
    const n = overview.peaks.length / 2, mid = h / 2
    ctx.fillStyle = muted; ctx.globalAlpha = 0.6
    for (let i = 0; i < n; i++) { const x = (i / n) * w; const min = overview.peaks[i * 2]!, max = overview.peaks[i * 2 + 1]!; ctx.fillRect(x, mid - max * (mid - 1), Math.max(1, w / n), Math.max(1, (max - min) * (mid - 1))) }
    ctx.globalAlpha = 1
    const x0 = (winStart / dur) * w, x1 = ((winStart + WINDOW) / dur) * w
    ctx.fillStyle = accent; ctx.globalAlpha = 0.18; ctx.fillRect(x0, 0, x1 - x0, h); ctx.globalAlpha = 0.9
    ctx.strokeStyle = accent; ctx.lineWidth = 1.5; ctx.strokeRect(x0 + 0.75, 0.75, x1 - x0 - 1.5, h - 1.5)
  }, [overview, winStart, dur])
  const secAt = (e: React.PointerEvent) => { const r = e.currentTarget.getBoundingClientRect(); return ((e.clientX - r.left) / r.width) * dur }
  return (
    <div className="relative">
      <canvas ref={ref} className={clsx('block h-10 w-full rounded-md border border-border bg-surface-2/40', dur ? 'cursor-grab active:cursor-grabbing' : '')}
        onPointerDown={(e) => { if (!dur) return; const s = secAt(e); const inside = s >= winStart && s <= winStart + WINDOW; drag.current = { grabOffset: inside ? s - winStart : WINDOW / 2 }; e.currentTarget.setPointerCapture(e.pointerId); onMove(s - drag.current.grabOffset) }}
        onPointerMove={(e) => { if (drag.current && dur) onMove(secAt(e) - drag.current.grabOffset) }}
        onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }} />
      {dur > 0 && <div className="pointer-events-none absolute inset-y-0 w-px bg-text" style={{ left: `${Math.min(100, Math.max(0, (time / dur) * 100))}%` }} />}
      {!overview && <div className="absolute inset-0 flex items-center justify-center text-[11px] text-muted"><Spinner className="mr-1 text-accent" /> reading the whole recording…</div>}
      {overview && <div className="pointer-events-none absolute right-1.5 top-0.5 text-[10px] tabular-nums text-muted">whole recording · drag the window</div>}
    </div>
  )
}

function TimeAxis({ startOffset, duration }: { startOffset: number; duration: number }) {
  const step = duration > 120 ? 30 : duration > 60 ? 10 : 5
  const ticks: number[] = []
  for (let t = 0; t <= duration + 0.01; t += step) ticks.push(t)
  return (
    <div className="relative h-4 text-[10px] tabular-nums text-muted">
      {ticks.map((t) => <span key={t} className="absolute -translate-x-1/2" style={{ left: `${(t / duration) * 100}%` }}>{fmtTime(startOffset + t)}</span>)}
    </div>
  )
}
