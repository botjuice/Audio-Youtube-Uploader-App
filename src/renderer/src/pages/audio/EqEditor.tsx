/** The EQ: an interactive curve and per-band knobs. */
import { clsx } from 'clsx'
import { RotateCcw } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { EQ_BANDS, defaultModules, type EqState, type Knob } from '@core/audio-modules'
import { eqResponseDb, logFrequencies } from '@core/eq-response'
import { Button, Switch } from '@/components/ui'
import { KnobRow } from './Strip'

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

export function EqEditor({ eq, onChange }: { eq: EqState; onChange: (eq: EqState) => void }) {
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
