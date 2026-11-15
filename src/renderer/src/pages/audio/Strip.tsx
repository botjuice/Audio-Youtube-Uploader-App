/** The channel strip's pieces: a module card and one knob. */
import { clsx } from 'clsx'
import { RotateCcw } from 'lucide-react'
import { type Knob } from '@core/audio-modules'
import { Badge, Select, Slider, Switch } from '@/components/ui'
import { fmtNum, fromPos, toPos, SLIDER_STEPS } from './shared'

// ── a module card: title, on/off, reset, knobs ────────────────────────────────

export function ModuleCard({ title, on, changed, onToggle, onReset, children }: { title: string; on: boolean; changed: boolean; onToggle: (v: boolean) => void; onReset: () => void; children: React.ReactNode }) {
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
export function KnobRow({ knob, value, disabled, error, onChange }: { knob: Knob; value: unknown; disabled: boolean; error?: string; onChange: (v: unknown) => void }) {
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
