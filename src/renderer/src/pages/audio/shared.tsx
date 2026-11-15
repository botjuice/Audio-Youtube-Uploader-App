/** Helpers and small pieces the Audio rules screens share. */
import { clsx } from 'clsx'
import { MODULE_TITLES } from '@core/audio-modules'
import type { ReportRow, SuggestNote } from '@core/audio-steer'

export const audioUrl = (file: string) => `yj-audio://preview/?p=${encodeURIComponent(file)}`

// ── helpers ───────────────────────────────────────────────────────────────────

export const fmtTime = (s: number) => { const m = Math.floor(s / 60), r = Math.floor(s - m * 60); return `${m}:${String(r).padStart(2, '0')}` }
export const fmtNum = (v: number, step: number) => v.toFixed(Math.min(4, (String(step).split('.')[1] ?? '').length))
export const db = (v: number, unit = 'dB') => { const x = Math.abs(v) < 0.05 ? 0 : v; return `${x > 0 ? '+' : ''}${x.toFixed(1)} ${unit}` }   // never "-0.0"

// Log sliders move in 1000 steps between min and max; linear ones use the knob's own range.
export const SLIDER_STEPS = 1000
export const toPos = (k: { min: number; max: number; log?: boolean }, v: number) => k.log ? Math.round(((Math.log(Math.max(k.min, v)) - Math.log(k.min)) / (Math.log(k.max) - Math.log(k.min))) * SLIDER_STEPS) : v
export const fromPos = (k: { min: number; max: number; step: number; log?: boolean }, p: number) => {
  if (!k.log) return p
  const raw = Math.exp(Math.log(k.min) + (p / SLIDER_STEPS) * (Math.log(k.max) - Math.log(k.min)))
  return Math.min(k.max, Math.max(k.min, Math.round(raw / k.step) * k.step))
}

export const DEFAULT_RULE = '\u0000default'
/** A recording's name for a chip or a card: no extension, and without the reciter's name it starts with. */
export const shortName = (fileName: string, folder: string) => {
  const base = fileName.replace(/\.[^.]+$/, '')
  return folder && base.toLowerCase().startsWith(folder.toLowerCase()) && base.length > folder.length ? base.slice(folder.length).replace(/^[-_ ]+/, '') : base
}
/** Reasons that read the same for several modules are shown once, with the modules named together. */
export function groupNotes(notes: SuggestNote[]): { modules: string; text: string }[] {
  const out: { keys: string[]; text: string }[] = []
  for (const n of notes) {
    const same = out.find((g) => g.text === n.text)
    if (same) same.keys.push(MODULE_TITLES[n.module]); else out.push({ keys: [MODULE_TITLES[n.module]], text: n.text })
  }
  return out.map((g) => ({ modules: g.keys.join(', '), text: g.text }))
}
export const newRuleId = () => `rule-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

export function Stat({ label, value, hint, tone, title }: { label: string; value: string; hint?: string; tone?: 'err'; title?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <div className="text-[11px] text-muted">{label}</div>
      <div className={clsx('whitespace-nowrap text-[13px] tabular-nums', tone === 'err' && 'text-err')}>{value}</div>
      {hint && <div className="truncate text-[10.5px] text-muted" title={hint}>{hint}</div>}
    </div>
  )
}

export function Segmented<T extends string>({ label, value, onChange, options }: { label: string; value: T; onChange: (v: T) => void; options: { value: T; label: React.ReactNode; title?: string }[] }) {
  return (
    <div className="inline-flex h-8 shrink-0 overflow-hidden rounded-lg border border-border text-xs" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)} title={o.title}
          className={clsx('inline-flex items-center gap-1 whitespace-nowrap px-2.5 no-drag transition-colors', value === o.value ? 'bg-accent/15 font-medium text-accent' : 'text-muted hover:text-text')}>{o.label}</button>
      ))}
    </div>
  )
}
/** Before / after / target for each thing a result is measured on. */
export function ResultTable({ rows, targetLabel }: { rows: ReportRow[]; targetLabel: string }) {
  return (
    <div className="mt-2 border-t border-border pt-2">
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] gap-x-4 gap-y-1 text-[11.5px] leading-snug">
        <div className="text-muted">Measured on the processed result</div><div className="text-right text-muted">Before</div><div className="text-right text-muted">After</div><div className="text-right text-muted">{targetLabel}</div>
        {rows.map((r) => (
          <div key={r.what} className="contents">
            <div>{r.what}</div><div className="text-right tabular-nums text-muted">{r.before}</div>
            <div className={clsx('text-right tabular-nums font-medium', !r.ok && 'text-warn')}>{r.after}</div><div className="text-right tabular-nums text-muted">{r.target}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** The reason for every module, folded away until asked for. */
export function Reasons({ notes }: { notes: SuggestNote[] }) {
  return (
    <details className="mt-2 border-t border-border pt-2">
      <summary className="cursor-pointer select-none text-[11.5px] text-muted hover:text-text no-drag">Why each module was set this way</summary>
      <ul className="mt-2 space-y-1 text-[11.5px] leading-snug">
        {groupNotes(notes).map((n, i) => <li key={i}><span className="font-medium">{n.modules}.</span> <span className="text-muted">{n.text}</span></li>)}
      </ul>
    </details>
  )
}
