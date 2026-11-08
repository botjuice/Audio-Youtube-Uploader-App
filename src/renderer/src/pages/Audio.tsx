import { clsx } from 'clsx'
import { AlertTriangle, AudioLines, Pause, Play, Repeat, RotateCcw, Save, Undo2, Waves } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AudioAnalysis, AudioLookPatch, AudioPreviewResult, AudioPreviewSide } from '@shared/types'
import { countKnobs, getKnob, mergePatches, prunePatch, setKnob } from '@core/thumb-rules'
import { DEFAULT_LOOK, LOOK_FIELDS, LOOK_PRESETS, REVERB_PRESETS, controllingToggle, describeLook, validateLook, type LookFieldInfo, type NumberField } from '../../../plugins/audio/look'
import { Badge, Button, Select, Slider, Spinner, Switch, Empty } from '@/components/ui'
import { errText, useStore } from '@/store'

const audioUrl = (file: string) => `yj-audio://preview/?p=${encodeURIComponent(file)}`

// ── helpers ───────────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>
const PREVIEW_SECONDS = 45
const GROUP_TITLES: Record<string, string> = { cleanup: 'Clean-up', tone: 'Tone (EQ)', dynamics: 'Compressor', reverb: 'Reverb', loudness: 'Loudness', limiter: 'Peak limiter', fades: 'Fades' }
const prune = (patch: unknown): AudioLookPatch => prunePatch((patch ?? {}) as Obj, DEFAULT_LOOK as unknown as Obj) as AudioLookPatch
const merge = (a: unknown, b: unknown): Obj => mergePatches(a as never, b as never) as unknown as Obj
const fmtTime = (s: number) => { const m = Math.floor(s / 60), r = Math.floor(s - m * 60); return `${m}:${String(r).padStart(2, '0')}` }
const fmtNum = (v: number, step: number) => v.toFixed((String(step).split('.')[1] ?? '').length)
const db = (v: number, unit = 'dB') => `${v > 0 ? '+' : ''}${v.toFixed(1)} ${unit}`

// Log sliders move in 1000 steps between min and max; linear ones use the field's own range.
const SLIDER_STEPS = 1000
const toPos = (f: NumberField, v: number) => f.scale === 'log' ? Math.round(((Math.log(v) - Math.log(f.min)) / (Math.log(f.max) - Math.log(f.min))) * SLIDER_STEPS) : v
const fromPos = (f: NumberField, p: number) => {
  if (f.scale !== 'log') return p
  const raw = Math.exp(Math.log(f.min) + (p / SLIDER_STEPS) * (Math.log(f.max) - Math.log(f.min)))
  return Math.min(f.max, Math.max(f.min, Math.round(raw / f.step) * f.step))
}

// ── preview hook: debounced, newest wins ──────────────────────────────────────

function useAudioPreview(sample: { recordId: string; start: number }, look: AudioLookPatch, enabled: boolean) {
  const [result, setResult] = useState<AudioPreviewResult | null>(null)
  const [rendering, setRendering] = useState(false)
  const seq = useRef(0)
  const key = JSON.stringify([sample, look])
  useEffect(() => {
    if (!enabled || !sample.recordId) return
    const mine = ++seq.current
    setRendering(true)
    const t = setTimeout(async () => {
      let r: AudioPreviewResult
      try { r = await window.api.renderAudioPreview({ recordId: sample.recordId, start: sample.start, seconds: PREVIEW_SECONDS, look }) }
      catch (e) { r = { ok: false, reason: 'RENDER_FAILED', message: errText(e) } }
      if (mine !== seq.current) return                 // superseded by a newer knob change
      if (!r.ok && r.reason === 'CANCELLED') return    // cancelled by that newer request
      setResult(r); setRendering(false)
    }, 500)
    return () => clearTimeout(t)
  }, [key, enabled])  // eslint-disable-line react-hooks/exhaustive-deps
  return { result, rendering }
}

// ── page ──────────────────────────────────────────────────────────────────────

export default function AudioPage() {
  const library = useStore((s) => s.library)
  const notify = useStore((s) => s.notify)
  const call = useStore((s) => s.call)
  const saving = useStore((s) => !!s.busy['audioLook'])
  const saved = library.audioLook
  const records = library.records
  const [look, setLook] = useState<AudioLookPatch>(() => prune(saved.look))
  const [sample, setSample] = useState<{ recordId: string; start: number }>(() => saved.sample ?? { recordId: records[0]?.id ?? '', start: 60 })
  const [analysis, setAnalysis] = useState<AudioAnalysis | null>(null)
  const [analysing, setAnalysing] = useState(false)
  useEffect(() => { setAnalysis(null) }, [sample.recordId])
  useEffect(() => { if (!sample.recordId && records[0]) setSample((s) => ({ ...s, recordId: records[0]!.id })) }, [records, sample.recordId])

  const resolved = useMemo(() => merge(DEFAULT_LOOK, look), [look])
  const validation = useMemo(() => validateLook(look), [look])
  const errors = validation.ok ? [] : validation.errors
  const knobs = countKnobs(look)
  const dirty = JSON.stringify(look) !== JSON.stringify(prune(saved.look)) || JSON.stringify(sample) !== JSON.stringify(saved.sample ?? sample)
  const summary = validation.ok ? describeLook(validation.look) : 'fix the knobs marked below'
  const record = records.find((r) => r.id === sample.recordId)
  const { result, rendering } = useAudioPreview(sample, look, validation.ok && !!record)

  const setKnobValue = (path: string, value: unknown) => {
    const def = getKnob(DEFAULT_LOOK, path)
    setLook((prev) => prune(setKnob(prev as Obj, path, value === def ? undefined : value)))
  }
  const resetGroup = (group: string) => setLook((prev) => { const next = { ...(prev as Obj) }; delete next[group]; return prune(next) })
  const save = () => void call('audioLook', async () => {
    await window.api.setAudioLook({ look, sample })
    notify('success', 'Audio look saved. Uploads still use the original audio for now.')
  })
  const discard = () => { setLook(prune(saved.look)); if (saved.sample) setSample(saved.sample) }
  const analyse = () => {
    if (!record) return
    setAnalysing(true)
    window.api.analyseAudio(record.id).then(setAnalysis).catch((e) => notify('error', errText(e))).finally(() => setAnalysing(false))
  }

  const groups = useMemo(() => {
    const m = new Map<string, LookFieldInfo[]>()
    for (const f of LOOK_FIELDS) { const g = f.path.split('.')[0]!; (m.get(g) ?? m.set(g, []).get(g)!).push(f) }
    return [...m.entries()]
  }, [])

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
        <span className="min-w-0 truncate text-xs text-muted" title={summary}>One Default look for every recording · {summary}</span>
        <div className="no-drag ml-auto flex shrink-0 items-center gap-2">
          <Badge tone={knobs ? 'info' : 'muted'} className="whitespace-nowrap">{knobs ? `${knobs} knob${knobs === 1 ? '' : 's'} changed` : 'plugin defaults'}</Badge>
          <Button size="sm" variant="ghost" disabled={!dirty || saving} onClick={discard}><Undo2 size={13} /> Discard</Button>
          <Button size="sm" disabled={!dirty || saving || errors.length > 0} onClick={save}><Save size={13} /> {saving ? 'Saving…' : 'Save look'}</Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        {/* left: knobs */}
        <aside className="w-[400px] shrink-0 overflow-y-auto border-r border-border">
          <div className="border-b border-border px-4 py-3">
            <div className="text-[13px] font-medium">Starting points</div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {Object.entries(LOOK_PRESETS).map(([k, p]) => <Button key={k} size="sm" variant="subtle" onClick={() => setLook(prune(p.patch))} title="Replaces every knob">{p.label}</Button>)}
            </div>
            <div className="mt-2 text-[11px] text-muted">Editor only for now: the look is saved with the library, and uploads keep using the original audio until processing is switched on in a later version.</div>
          </div>
          {groups.map(([group, fields]) => {
            const toggle = fields.find((f) => f.path === `${group}.enabled`)
            const on = toggle ? getKnob(resolved, toggle.path) !== false : true
            const changed = countKnobs((look as Obj)[group])
            return (
              <section key={group} className={clsx('border-b border-border px-4 py-3', !on && 'opacity-70')}>
                <div className="flex items-center gap-2">
                  <div className="text-[13px] font-medium">{GROUP_TITLES[group] ?? group}</div>
                  {changed > 0 && <Badge tone="info">{changed}</Badge>}
                  <div className="ml-auto flex items-center gap-2">
                    {changed > 0 && <button type="button" className="text-[11px] text-muted hover:text-text no-drag" onClick={() => resetGroup(group)} title="Back to the plugin's defaults for this section"><RotateCcw size={11} className="inline" /> reset</button>}
                    {toggle && <Switch checked={on} onChange={(v) => setKnobValue(toggle.path, v)} label={toggle.field.label} />}
                  </div>
                </div>
                {group === 'reverb' && on && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {Object.entries(REVERB_PRESETS).map(([k, p]) => <Button key={k} size="sm" variant="subtle" onClick={() => setLook(prune(merge(look, p.patch)))} title="Sets decay, pre-delay, brightness, amount and width">{p.label}</Button>)}
                  </div>
                )}
                <div className="mt-2 space-y-2.5">
                  {fields.filter((f) => f !== toggle).map((f) => <Knob key={f.path} info={f} look={look} resolved={resolved} errors={errors} onChange={setKnobValue} />)}
                </div>
              </section>
            )
          })}
        </aside>

        {/* right: sample + A/B player */}
        <main className="min-w-0 flex-1 overflow-y-auto p-5 space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="min-w-0 flex-1 text-xs text-muted">
              <div className="mb-1">Recording to listen to</div>
              <Select value={sample.recordId} onChange={(e) => setSample({ recordId: e.target.value, start: 60 })} className="h-8 w-full text-[13px]">
                {records.map((r) => <option key={r.id} value={r.id}>{r.reciterFolder ? `${r.reciterFolder} / ` : ''}{r.fileName}</option>)}
              </Select>
            </label>
            <label className="text-xs text-muted">
              <div className="mb-1">Excerpt starts at</div>
              <div className="flex items-center gap-1">
                <Button size="sm" variant="subtle" onClick={() => setSample((s) => ({ ...s, start: Math.max(0, s.start - 60) }))}>−1 min</Button>
                <input type="number" min={0} step={5} value={sample.start} onChange={(e) => setSample((s) => ({ ...s, start: Math.max(0, Number(e.target.value) || 0) }))}
                  className="h-8 w-20 rounded-lg border border-border bg-surface px-2 text-center text-[13px] tabular-nums no-drag" />
                <span className="text-[11px]">s</span>
                <Button size="sm" variant="subtle" onClick={() => setSample((s) => ({ ...s, start: s.start + 60 }))}>+1 min</Button>
              </div>
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
            <div className="rounded-xl border border-err/40 bg-err/6 px-4 py-3 text-xs"><b>Some knobs are out of range:</b> {errors.map((e) => `${e.key}: ${e.message}`).join(' · ')}</div>
          )}
          {!record ? <Empty icon={<AudioLines size={28} />} title="Choose a recording" />
            : result?.ok ? <AbPlayer processed={result.processed} original={result.original} startOffset={sample.start} stale={rendering} />
            : result ? (
              <div className="rounded-xl border border-warn/40 bg-warn/6 px-4 py-3 text-xs">
                <div className="flex items-center gap-2 font-medium"><AlertTriangle size={14} /> Can't render ({result.reason})</div>
                <div className="mt-1 whitespace-pre-wrap text-muted">{result.message}</div>
              </div>
            ) : (
              <div className="flex h-56 items-center justify-center rounded-xl border border-border bg-surface text-xs text-muted">
                {rendering ? <><Spinner className="mr-2 text-accent" /> Rendering a {PREVIEW_SECONDS} s excerpt (original and processed at the same loudness)…</> : 'Change a knob or pick a recording to hear it.'}
              </div>
            )}
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

// ── one knob ──────────────────────────────────────────────────────────────────

function Knob({ info, look, resolved, errors, onChange }: { info: LookFieldInfo; look: AudioLookPatch; resolved: Obj; errors: { key: string; message: string }[]; onChange: (path: string, v: unknown) => void }) {
  const { path, field } = info
  const value = getKnob(resolved, path)
  const own = getKnob(look, path)
  const changed = own !== undefined
  const ctrl = controllingToggle(path)
  const disabled = !!ctrl && getKnob(resolved, ctrl) === false
  const error = errors.find((e) => e.key === path)?.message
  if (field.kind === 'toggle') {
    return (
      <div className={clsx('flex items-center gap-2 text-[12px]', disabled && 'opacity-50')} title={field.desc}>
        <span className={clsx('flex-1', changed && 'font-medium text-accent')}>{field.label}</span>
        <Switch checked={value === true} onChange={(v) => onChange(path, v)} disabled={disabled} label={field.label} />
      </div>
    )
  }
  const n = typeof value === 'number' ? value : field.default
  return (
    <div className={clsx('space-y-1', disabled && 'opacity-50')}>
      <div className="flex items-center gap-1.5 text-[12px]" title={field.desc}>
        <span className={clsx(changed && 'font-medium text-accent')}>{field.label}</span>
        <span className="min-w-0 flex-1 truncate text-[10.5px] text-muted">{field.desc}</span>
        {changed && <button type="button" className="text-muted hover:text-text no-drag" title={`Back to ${fmtNum(field.default, field.step)} ${field.unit}`} onClick={() => onChange(path, undefined)}><RotateCcw size={11} /></button>}
      </div>
      <div className="flex items-center gap-2">
        <Slider value={toPos(field, n)} min={field.scale === 'log' ? 0 : field.min} max={field.scale === 'log' ? SLIDER_STEPS : field.max} step={field.scale === 'log' ? 1 : field.step}
          onChange={(p) => onChange(path, fromPos(field, p))} disabled={disabled} className="flex-1" />
        <input type="number" value={fmtNum(n, field.step)} min={field.min} max={field.max} step={field.step} disabled={disabled}
          onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) onChange(path, Math.min(field.max, Math.max(field.min, v))) }}
          className={clsx('h-7 w-20 rounded-lg border bg-surface px-1.5 text-right text-[12px] tabular-nums no-drag', error ? 'border-err' : 'border-border')} />
        <span className="w-9 text-[10.5px] text-muted">{field.unit}</span>
      </div>
      {error && <div className="text-[11px] text-err">{error}</div>}
    </div>
  )
}

// ── A/B transport: decoded buffers on one Web Audio clock ─────────────────────
//
// Two <audio> elements would have to reload on every re-render (a gap, and a reload that resets the
// position). Instead both excerpts are decoded once and played from AudioBufferSourceNodes started at
// the same context time. A new render starts fresh sources at the exact current position and
// crossfades them in over a few milliseconds while the old ones fade out; switching sides is a gain ramp.

type Side = 'original' | 'processed'
interface Pair<T> { original: T; processed: T }
interface Voice { src: AudioBufferSourceNode; gain: GainNode }
const XFADE = 0.03

class Transport {
  readonly ctx = new AudioContext()
  private buffers: Pair<AudioBuffer> | null = null
  private voices: Pair<Voice> | null = null
  private startedAt = 0      // ctx time at which position 0 played (while playing)
  private position = 0       // position while paused
  playing = false
  side: Side = 'processed'
  loop = true
  onEnded: (() => void) | null = null

  get duration(): number { return this.buffers ? Math.min(this.buffers.original.duration, this.buffers.processed.duration) : 0 }
  get time(): number {
    if (!this.playing || !this.buffers) return this.position
    const t = this.ctx.currentTime - this.startedAt
    return this.loop && this.duration > 0 ? t % this.duration : Math.min(t, this.duration)
  }

  private voice(buffer: AudioBuffer, audible: boolean, at: number, offset: number): Voice {
    const src = this.ctx.createBufferSource()
    src.buffer = buffer
    src.loop = this.loop; src.loopStart = 0; src.loopEnd = this.duration
    const gain = this.ctx.createGain()
    gain.gain.setValueAtTime(audible ? 1 : 0, at)
    src.connect(gain).connect(this.ctx.destination)
    src.start(at, offset)
    return { src, gain }
  }

  private startVoices(at: number, offset: number): Pair<Voice> {
    const b = this.buffers!
    const v = { original: this.voice(b.original, this.side === 'original', at, offset), processed: this.voice(b.processed, this.side === 'processed', at, offset) }
    v[this.side].src.onended = () => { if (!this.loop && this.voices === v) { this.playing = false; this.position = 0; this.onEnded?.() } }
    return v
  }

  private stopVoices(v: Pair<Voice>, at: number, fade: number): void {
    for (const side of ['original', 'processed'] as const) {
      const { src, gain } = v[side]
      src.onended = null
      gain.gain.cancelScheduledValues(at); gain.gain.setValueAtTime(gain.gain.value, at); gain.gain.linearRampToValueAtTime(0, at + fade)
      try { src.stop(at + fade + 0.01) } catch { /* already stopped */ }
    }
  }

  /** New render: keep playing without a gap — the new voices start at the current position and crossfade in. */
  load(buffers: Pair<AudioBuffer>): void {
    const wasPlaying = this.playing
    const pos = this.time
    const old = this.voices
    this.buffers = buffers
    this.position = Math.min(pos, Math.max(0, this.duration - 0.05))
    if (wasPlaying) {
      const at = this.ctx.currentTime + 0.005
      const v = this.startVoices(at, this.position)
      v[this.side].gain.gain.setValueAtTime(0, at); v[this.side].gain.gain.linearRampToValueAtTime(1, at + XFADE)
      if (old) this.stopVoices(old, at, XFADE)
      this.voices = v
      this.startedAt = at - this.position
    } else if (old) { this.stopVoices(old, this.ctx.currentTime, 0.005); this.voices = null }
  }

  async play(): Promise<void> {
    if (!this.buffers || this.playing) return
    await this.ctx.resume()
    const at = this.ctx.currentTime + 0.005
    this.voices = this.startVoices(at, this.position)
    this.startedAt = at - this.position
    this.playing = true
  }

  pause(): void {
    if (!this.playing) return
    this.position = this.time
    if (this.voices) this.stopVoices(this.voices, this.ctx.currentTime, 0.008)
    this.voices = null
    this.playing = false
  }

  seek(t: number): void {
    const c = Math.min(Math.max(0, t), Math.max(0, this.duration - 0.05))
    if (!this.playing) { this.position = c; return }
    const at = this.ctx.currentTime + 0.005
    if (this.voices) this.stopVoices(this.voices, at, 0.008)
    this.voices = this.startVoices(at, c)
    this.startedAt = at - c
  }

  setSide(side: Side): void {
    this.side = side
    if (!this.voices) return
    const at = this.ctx.currentTime
    for (const s of ['original', 'processed'] as const) {
      const g = this.voices[s].gain.gain
      g.cancelScheduledValues(at); g.setValueAtTime(g.value, at); g.linearRampToValueAtTime(s === side ? 1 : 0, at + 0.015)
      this.voices[s].src.onended = s === side ? () => { if (!this.loop && this.voices) { this.playing = false; this.position = 0; this.onEnded?.() } } : null
    }
  }

  setLoop(loop: boolean): void {
    this.loop = loop
    if (this.voices) for (const s of ['original', 'processed'] as const) this.voices[s].src.loop = loop
  }

  dispose(): void { this.pause(); void this.ctx.close() }
}

const decoded = new Map<string, Promise<AudioBuffer>>()
function decode(ctx: AudioContext, file: string): Promise<AudioBuffer> {
  let p = decoded.get(file)
  if (!p) {
    p = fetch(audioUrl(file)).then((r) => { if (!r.ok) throw new Error(`Could not load ${file.split('/').pop()} (${r.status})`); return r.arrayBuffer() }).then((ab) => ctx.decodeAudioData(ab))
    decoded.set(file, p)
    p.catch(() => decoded.delete(file))
    if (decoded.size > 12) decoded.delete(decoded.keys().next().value!)   // the plugin caches files; we keep a few decodes around for quick A/B of knob states
  }
  return p
}

function AbPlayer({ processed, original, startOffset, stale }: { processed: AudioPreviewSide; original: AudioPreviewSide; startOffset: number; stale: boolean }) {
  const notify = useStore((s) => s.notify)
  const tRef = useRef<Transport | null>(null)
  const transport = () => (tRef.current ??= new Transport())
  const [which, setWhich] = useState<Side>('processed')
  const [playing, setPlaying] = useState(false)
  const [loop, setLoop] = useState(true)
  const [time, setTime] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [duration, setDuration] = useState(Math.min(processed.durationSec, original.durationSec) || processed.durationSec)
  useEffect(() => () => { tRef.current?.dispose(); tRef.current = null }, [])

  // Decode the new pair and hand it to the transport (which keeps playing through the swap). Newest wins.
  const loadSeq = useRef(0)
  useEffect(() => {
    const t = transport(), mine = ++loadSeq.current
    let live = true
    setLoading(true); setLoadError(null)
    Promise.all([decode(t.ctx, original.file), decode(t.ctx, processed.file)]).then(([o, p]) => {
      if (!live || mine !== loadSeq.current) return
      t.load({ original: o, processed: p })
      setDuration(t.duration); setTime(t.time); setLoading(false)
    }).catch((e) => { if (live && mine === loadSeq.current) { setLoading(false); setLoadError(errText(e)); notify('error', errText(e)) } })
    return () => { live = false }
  }, [original.file, processed.file])  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { transport().onEnded = () => { setPlaying(false); setTime(0) } }, [])
  useEffect(() => {   // clock display while playing
    if (!playing) return
    let raf = 0
    const tick = () => { setTime(transport().time); raf = requestAnimationFrame(tick) }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing])

  const play = () => void transport().play().then(() => setPlaying(transport().playing))
  const pause = () => { transport().pause(); setPlaying(false); setTime(transport().time) }
  const seek = (t: number) => { transport().seek(t); setTime(transport().time) }
  const pick = (s: Side) => { transport().setSide(s); setWhich(s) }
  const toggleLoop = () => setLoop((l) => { transport().setLoop(!l); return !l })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      if (e.key === ' ') { e.preventDefault(); playing ? pause() : play() }
      else if (e.key.toLowerCase() === 's') pick(which === 'original' ? 'processed' : 'original')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })  // eslint-disable-line react-hooks/exhaustive-deps

  const audible = which === 'processed' ? processed : original
  return (
    <div className="rounded-xl border border-border bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <Button size="sm" onClick={playing ? pause : play} disabled={(loading || !!loadError) && !playing}>{playing ? <Pause size={14} /> : <Play size={14} />} {playing ? 'Pause' : 'Play'}</Button>
        <div className="inline-flex overflow-hidden rounded-lg border border-border text-xs">
          {(['original', 'processed'] as const).map((w) => (
            <button key={w} type="button" onClick={() => pick(w)} className={clsx('px-3 h-8 no-drag transition-colors', which === w ? 'bg-accent/15 text-accent font-medium' : 'text-muted hover:text-text')}>{w === 'original' ? 'Original' : 'Processed'}</button>
          ))}
        </div>
        <button type="button" onClick={toggleLoop} className={clsx('inline-flex h-8 items-center gap-1 rounded-lg border px-2.5 text-xs no-drag', loop ? 'border-accent/40 text-accent bg-accent/10' : 'border-border text-muted')} title="Loop the excerpt"><Repeat size={13} /> Loop</button>
        <span className="text-xs tabular-nums text-muted">{fmtTime(startOffset + time)} / {fmtTime(startOffset + duration)}</span>
        {(stale || loading) && <span className="inline-flex items-center gap-1 text-xs text-muted"><Spinner className="text-accent" /> {stale ? 'rendering the new knobs…' : 'loading…'}</span>}
        {loadError && !loading && <span className="inline-flex items-center gap-1 text-xs text-err"><AlertTriangle size={13} /> {loadError}</span>}
        <span className="ml-auto text-[11px] text-muted">Space = play/pause · S = switch · both lanes share one clock</span>
      </div>
      <div className={clsx('px-4 py-3 space-y-2 transition-opacity', stale && 'opacity-80')}>
        <Lane label="Original" side={original} active={which === 'original'} time={time} duration={duration} onSeek={seek} onPick={() => pick('original')} />
        <Lane label="Processed" side={processed} active={which === 'processed'} time={time} duration={duration} onSeek={seek} onPick={() => pick('processed')} />
        <TimeAxis startOffset={startOffset} duration={duration} />
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 border-t border-border px-4 py-3 text-xs sm:grid-cols-4">
        <Stat label="Loudness (both matched)" value={`${audible.lufs.toFixed(1)} LUFS`} hint={`original ${original.lufs.toFixed(1)} · processed ${processed.lufs.toFixed(1)}`} />
        <Stat label="True peak" value={db(audible.truePeak, 'dBTP')} hint={`original ${db(original.truePeak, '')} · processed ${db(processed.truePeak, '')}`} />
        <Stat label="Gain applied" value={db(processed.gainDb)} hint="by the loudness stage" />
        <Stat label="Channels" value={processed.channels === 2 ? 'stereo' : 'mono'} hint={processed.channels === 2 ? 'reverb makes it stereo' : undefined} />
        {(processed.warnings.length > 0 || original.warnings.length > 0) && <div className="col-span-full text-[11px] text-warn">{[...processed.warnings, ...original.warnings].join(' · ')}</div>}
      </div>
    </div>
  )
}

function Lane({ label, side, active, time, duration, onSeek, onPick }: { label: string; side: AudioPreviewSide; active: boolean; time: number; duration: number; onSeek: (t: number) => void; onPick: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current; if (!c) return
    const dpr = window.devicePixelRatio || 1
    const w = c.clientWidth, h = c.clientHeight
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr)
    const ctx = c.getContext('2d'); if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, w, h)
    const cs = getComputedStyle(c)
    const colour = active ? cs.getPropertyValue('--accent').trim() || '#6366f1' : cs.getPropertyValue('--muted').trim() || '#64748b'
    const n = side.peaks.length / 2, mid = h / 2
    ctx.fillStyle = colour
    ctx.globalAlpha = active ? 0.95 : 0.55
    for (let i = 0; i < n; i++) {
      const x = (i / n) * w
      const min = side.peaks[i * 2]!, max = side.peaks[i * 2 + 1]!
      const y1 = mid - max * (mid - 1), y2 = mid - min * (mid - 1)
      ctx.fillRect(x, y1, Math.max(1, w / n), Math.max(1, y2 - y1))
    }
    ctx.globalAlpha = 1
    const px = duration ? (time / duration) * w : 0
    ctx.fillStyle = cs.getPropertyValue('--text').trim() || '#fff'
    ctx.fillRect(px - 0.5, 0, 1, h)
  }, [side.peaks, active, time, duration])
  return (
    <div className={clsx('relative rounded-lg border', active ? 'border-accent/50 bg-accent/5' : 'border-border bg-surface-2/40')}>
      <button type="button" onClick={onPick} className={clsx('absolute left-2 top-1.5 z-10 rounded px-1.5 text-[10.5px] no-drag', active ? 'bg-accent text-white' : 'bg-surface text-muted hover:text-text')}>{label}{active ? ' · playing' : ''}</button>
      <canvas ref={ref} className="block h-24 w-full cursor-crosshair"
        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); onSeek(((e.clientX - r.left) / r.width) * duration) }} />
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
