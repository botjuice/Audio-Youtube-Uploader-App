import { clsx } from 'clsx'
import { AlertTriangle, AudioLines, Pause, Play, Repeat, RotateCcw, Save, Undo2, Waves } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AudioAnalysis, AudioLookPatch, AudioOverview } from '@shared/types'
import { countKnobs, getKnob, mergePatches, prunePatch, setKnob } from '@core/thumb-rules'
import { DEFAULT_LOOK, LOOK_FIELDS, LOOK_PRESETS, REVERB_PRESETS, controllingToggle, describeLook, validateLook, type LookFieldInfo, type NumberField } from '../../../plugins/audio/look'
import { Badge, Button, Select, Slider, Spinner, Switch, Empty } from '@/components/ui'
import { errText, useStore } from '@/store'

const audioUrl = (file: string) => `yj-audio://preview/?p=${encodeURIComponent(file)}`

// ── helpers ───────────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>
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
  const setStart = (start: number) => setSample((s) => (Math.abs(s.start - start) < 0.01 ? s : { ...s, start }))

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
            : <Workbench key={record.id} recordId={record.id} look={look} lookOk={validation.ok} winStart={sample.start} onWinStart={setStart} />}
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
  buffer: AudioBuffer; offset: number; peaks: number[]; gainDb: number; lufs: number; truePeak: number; channels: number
}
interface Voice { src: AudioBufferSourceNode; gain: GainNode; tile: Loaded; endAt: number }

/** Gain changes must be scheduled a little ahead: anything at "now" is already rendered and lands as a hard step. */
const LEAD = 0.012
/** Fade when a voice starts or stops mid-waveform (play, pause, seek, side switch). */
const ENTER = 0.012

class TileTransport {
  // the plugin writes 48 kHz; decoding into a 44.1 kHz context would resample every chunk on its own and roughen the joins
  readonly ctx = new AudioContext({ sampleRate: 48000 })
  /** every voice goes through here (one place to meter or tap the mix) */
  readonly master = this.ctx.createGain()
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

  constructor() { this.master.connect(this.ctx.destination) }

  get time(): number { return this.playing ? this.ctx.currentTime - this.startedAt : this.pos }

  private linearGain(t: Loaded): number {
    if (t.kind === 'original') return this.originalGain
    return this.refGain === null ? 1 : Math.pow(10, (this.refGain - t.gainDb) / 20)
  }
  private target(t: Loaded): number { return t.kind === this.side ? this.linearGain(t) : 0 }

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
    const gain = this.ctx.createGain()
    const g = this.target(t)
    if (ramp > 0) { gain.gain.setValueAtTime(0, at); gain.gain.linearRampToValueAtTime(g, at + ramp) } else gain.gain.setValueAtTime(g, at)
    if (endAt - (post + JOIN) > at + ramp) { gain.gain.setValueAtTime(g, endAt - (post + JOIN)); gain.gain.linearRampToValueAtTime(0, endAt) }
    src.connect(gain).connect(this.master)
    src.start(at, offset, dur)
    const v: Voice = { src, gain, tile: t, endAt }
    src.onended = () => { if (into.get(t.key) === v) into.delete(t.key) }
    into.set(t.key, v)
  }

  /** Fade a voice out and stop it, starting a little ahead so the ramp really renders. */
  private stop(v: Voice, fade: number, at = this.ctx.currentTime + LEAD): void {
    v.src.onended = null
    const g = v.gain.gain
    g.cancelAndHoldAtTime(at); g.linearRampToValueAtTime(0, at + fade)
    try { v.src.stop(at + fade + 0.01) } catch { /* already stopped */ }
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
    const voices = this.startLap(base, wrapAt, ENTER)
    for (const v of this.voices.values()) this.stop(v, ENTER, wrapAt)
    this.lap = { at: wrapAt, startedAt: base, voices }
  }
  private disarmLoop(): void {
    if (!this.lap) return
    for (const v of this.lap.voices.values()) { v.src.onended = null; try { v.src.stop() } catch { /* not started */ } }
    this.lap = null
  }

  /** Called from the display loop. */
  tick(): void {
    if (!this.playing) return
    const now = this.ctx.currentTime
    if (this.lap && now >= this.lap.at) { this.startedAt = this.lap.startedAt; this.voices = this.lap.voices; this.lap = null; return }
    if (this.loop) { if (!this.lap && this.time >= this.win.end - 0.5) this.armLoop() }
    else if (this.time >= this.win.end) this.pause()
  }

  private retarget(): void {
    const at = this.ctx.currentTime + LEAD
    const all = [...this.voices.values(), ...(this.lap ? this.lap.voices.values() : [])]
    for (const v of all) {
      const g = v.gain.gain, target = this.target(v.tile)
      if (v.endAt <= at) continue
      g.cancelAndHoldAtTime(at); g.linearRampToValueAtTime(target, at + ENTER)
      const fadeStart = v.endAt - 2 * JOIN   // keep the join fade-out that the cancel just removed
      if (fadeStart > at + ENTER) { g.setValueAtTime(target, fadeStart); g.linearRampToValueAtTime(0, v.endAt) }
    }
  }
  setSide(side: Side): void { this.side = side; this.retarget() }
  setOriginalGain(g: number): void { this.originalGain = g; this.retarget() }
  setRefGain(g: number | null): void { this.refGain = g; this.retarget() }
  setLoop(loop: boolean): void { this.loop = loop; if (!loop) this.disarmLoop() }
  dispose(): void { this.pause(); void this.ctx.close() }
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

function Workbench({ recordId, look, lookOk, winStart, onWinStart }: { recordId: string; look: AudioLookPatch; lookOk: boolean; winStart: number; onWinStart: (s: number) => void }) {
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
    const resolved = merge(DEFAULT_LOOK, look) as { loudness?: { enabled?: boolean; target?: number } }
    const target = resolved.loudness?.enabled === false ? null : resolved.loudness?.target ?? null
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
          const loaded: Loaded = { key, kind: w.kind, index: w.index, gen, buffer, offset: r.tile.offset, peaks: r.tile.peaks, gainDb: r.tile.gainDb, lufs: r.tile.lufs, truePeak: r.tile.truePeak, channels: r.tile.channels }
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
        <div className="flex items-center gap-2 whitespace-nowrap">
          <Button size="sm" onClick={playing ? pause : play} className="w-24 justify-center">{playing ? <Pause size={14} /> : <Play size={14} />} {playing ? 'Pause' : 'Play'}</Button>
          <div className="inline-flex overflow-hidden rounded-lg border border-border text-xs">
            {(['original', 'processed'] as const).map((w) => (
              <button key={w} type="button" onClick={() => pick(w)} className={clsx('px-3 h-8 no-drag transition-colors', which === w ? 'bg-accent/15 text-accent font-medium' : 'text-muted hover:text-text')}>{w === 'original' ? 'Original' : 'Processed'}</button>
            ))}
          </div>
          <button type="button" onClick={toggleLoop} className={clsx('inline-flex h-8 items-center gap-1 rounded-lg border px-2.5 text-xs no-drag', loop ? 'border-accent/40 text-accent bg-accent/10' : 'border-border text-muted')} title="Loop the window"><Repeat size={13} /> Loop</button>
          <label className="inline-flex h-8 items-center gap-2 rounded-lg border border-border px-2.5 text-xs text-muted" title="Off: the original plays exactly as recorded. On: the original gets one fixed gain so it sits at the look's target loudness — louder never sounds better, so you judge tone and noise alone. The final clip is not affected either way.">
            <Switch checked={matchLoudness} onChange={setMatchLoudness} label="Match loudness" disabled={!overview} /> Match loudness
          </label>
          <span className="ml-auto min-w-0 truncate text-xs tabular-nums text-muted">{fmtTime(time)} · window {fmtTime(winStart)}–{fmtTime(winStart + WINDOW)}{Number.isFinite(duration) ? ` of ${fmtTime(duration)}` : ''}</span>
        </div>
        <div className="mt-1.5 flex h-4 items-center gap-2 whitespace-nowrap text-[11px] text-muted">
          <span className="inline-flex w-64 shrink-0 items-center gap-1 tabular-nums">
            {ready.processed < total && lookOk ? <><Spinner className="text-accent" /> {ready.processed}/{total} chunks{ready.stale ? ` · ${ready.stale} from the previous knobs playing` : ''}</> : <span className="text-muted/70">all {total} chunks ready</span>}
          </span>
          <span className="ml-auto truncate">Space play · S switch · ←/→ move · scroll over the lanes · drag the window below</span>
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
