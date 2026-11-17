/** The A/B player: original and processed lanes on one clock. */
import { clsx } from 'clsx'
import { AlertTriangle, ChevronsRight, Keyboard, Pause, Play, Repeat } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AudioLook, AudioOverview } from '@shared/types'
import { Button, Spinner, Switch } from '@/components/ui'
import { errText, useStore } from '@/store'
import { Segmented, Stat, audioUrl, db, fmtTime } from './shared'

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
    p = fetch(audioUrl(file)).then(async (r) => { if (!r.ok) throw new Error(`Could not load ${file.split(/[\\/]/).pop()}: ${(await r.text().catch(() => '')) || 'no reason given'} (${r.status})`); return r.arrayBuffer() }).then((ab) => ctx.decodeAudioData(ab))
    decoded.set(file, p)
    p.catch(() => decoded.delete(file))
    if (decoded.size > 64) decoded.delete(decoded.keys().next().value!)
  }
  return p
}

type Mode = 'loop' | 'continuous'

/** remembered across recordings for the session */
let lastMode: Mode = 'loop'
/** a lane/axis/overview places itself each animation frame: `viewStart` = recording second at the lanes' left edge */
type Placer = (viewStart: number, time: number) => void

/** Continuous mode's view: the playhead in the middle, but never past either end of the recording (there the needle moves instead). */
function followStart(time: number, duration: number): number {
  const max = Number.isFinite(duration) ? Math.max(0, duration - WINDOW) : Infinity
  return Math.min(max, Math.max(0, time - WINDOW / 2))
}

export function Workbench({ recordId, look, lookOk, winStart, onWinStart }: { recordId: string; look: AudioLook; lookOk: boolean; winStart: number; onWinStart: (s: number) => void }) {
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
