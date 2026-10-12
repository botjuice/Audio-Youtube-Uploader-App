import { clsx } from 'clsx'
import { X } from 'lucide-react'
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'
import type { Tone } from '@/lib/format'

type Variant = 'default' | 'primary' | 'danger' | 'ghost' | 'subtle'
type Size = 'sm' | 'md' | 'lg'

const sizes: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1.5 rounded-md',
  md: 'h-8.5 px-3.5 text-[13px] gap-2 rounded-lg',
  lg: 'h-10 px-4 text-sm gap-2 rounded-lg',
}
const variants: Record<Variant, string> = {
  default: 'bg-surface border border-border hover:bg-surface-2 text-text shadow-xs',
  primary: 'bg-accent text-accent-fg hover:brightness-110 shadow-sm font-medium',
  danger:  'bg-err/10 text-err border border-err/30 hover:bg-err/20',
  ghost:   'hover:bg-surface-2 text-text',
  subtle:  'bg-surface-2 hover:brightness-105 text-text',
}

export function Button({ variant = 'default', size = 'md', className, ...p }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button
      {...p}
      className={clsx('inline-flex items-center justify-center whitespace-nowrap select-none transition-colors no-drag',
        'disabled:opacity-45 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-accent/60',
        sizes[size], variants[variant], className)}
    />
  )
}

export function IconButton({ className, label, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button {...p} title={label} aria-label={label}
      className={clsx('inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:text-text hover:bg-surface-2 transition-colors no-drag disabled:opacity-40', className)} />
  )
}

export function Input({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input {...p}
      className={clsx('h-8.5 w-full rounded-lg border border-border bg-surface px-3 text-[13px] placeholder:text-muted/70',
        'focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent/50 transition no-drag disabled:opacity-50', className)} />
  )
}

export function Textarea({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea {...p}
      className={clsx('w-full rounded-lg border border-border bg-surface px-3 py-2 text-[13px] placeholder:text-muted/70 resize-y min-h-20',
        'focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent/50 transition no-drag', className)} />
  )
}

export function Select({ className, children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...p}
      className={clsx('h-8.5 rounded-lg border border-border bg-surface px-2.5 pr-7 text-[13px] appearance-none no-drag',
        'focus:outline-none focus:ring-2 focus:ring-accent/40 bg-no-repeat bg-[right_0.5rem_center]',
        "bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='2.5'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")]",
        className)}>
      {children}
    </select>
  )
}

export function Switch({ checked, onChange, disabled, label }:
  { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx('relative inline-flex h-5.5 w-9.5 shrink-0 items-center rounded-full transition-colors no-drag disabled:opacity-40',
        checked ? 'bg-accent' : 'bg-border')}>
      <span className={clsx('inline-block h-4.5 w-4.5 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-4.5' : 'translate-x-0.5')} />
    </button>
  )
}

export function Checkbox({ checked, onChange, disabled, indeterminate }:
  { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; indeterminate?: boolean }) {
  return (
    <button type="button" role="checkbox" aria-checked={indeterminate ? 'mixed' : checked} disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onChange(!checked) }}
      className={clsx('inline-flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-[5px] border transition-colors no-drag',
        'disabled:opacity-30',
        checked || indeterminate ? 'bg-accent border-accent text-accent-fg' : 'border-border bg-surface hover:border-muted')}>
      {indeterminate ? <span className="h-0.5 w-2.5 rounded bg-current" /> :
        checked && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5"><path d="M5 13l4 4L19 7" /></svg>}
    </button>
  )
}

const toneClasses: Record<Tone, string> = {
  ok: 'bg-ok/12 text-ok', warn: 'bg-warn/14 text-warn', err: 'bg-err/12 text-err',
  info: 'bg-info/12 text-info', accent: 'bg-accent/12 text-accent', muted: 'bg-surface-2 text-muted',
}
export function Badge({ tone = 'muted', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={clsx('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium leading-4 whitespace-nowrap', toneClasses[tone], className)}>{children}</span>
}

export function Chip({ active, onClick, children, title }: { active: boolean; onClick?: () => void; children: ReactNode; title?: string }) {
  return (
    <button type="button" onClick={onClick} title={title}
      className={clsx('inline-flex items-center gap-1 rounded-full border px-2.5 h-6.5 text-xs transition-colors no-drag max-w-full',
        active ? 'bg-accent/12 border-accent/40 text-accent' : 'bg-surface border-border text-muted line-through hover:text-text')}>
      <span className="truncate">{children}</span>
    </button>
  )
}

export function Card({ title, subtitle, actions, children, className }:
  { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={clsx('rounded-xl border border-border bg-surface shadow-xs', className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-3 px-4 pt-3.5 pb-2">
          <div><h3 className="text-[13.5px] font-semibold">{title}</h3>{subtitle && <p className="text-xs text-muted mt-0.5">{subtitle}</p>}</div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="px-4 pb-4">{children}</div>
    </section>
  )
}

export function Field({ label, hint, children, inline }: { label: ReactNode; hint?: ReactNode; children: ReactNode; inline?: boolean }) {
  return (
    <label className={clsx('block', inline && 'flex items-center justify-between gap-4')}>
      <div className={clsx(!inline && 'mb-1.5')}>
        <div className="text-[12.5px] font-medium">{label}</div>
        {hint && <div className="text-xs text-muted mt-0.5">{hint}</div>}
      </div>
      {children}
    </label>
  )
}

export function ProgressBar({ value, tone = 'accent', className }: { value: number; tone?: Tone; className?: string }) {
  const color = { ok: 'bg-ok', warn: 'bg-warn', err: 'bg-err', info: 'bg-info', accent: 'bg-accent', muted: 'bg-muted' }[tone]
  return (
    <div className={clsx('h-1.5 w-full overflow-hidden rounded-full bg-surface-2', className)}>
      <div className={clsx('h-full rounded-full transition-[width] duration-300', color)} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  )
}

export function Empty({ icon, title, hint, action }: { icon?: ReactNode; title: string; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-10 text-center">
      {icon && <div className="text-muted/60 mb-1">{icon}</div>}
      <div className="text-sm font-medium">{title}</div>
      {hint && <div className="text-xs text-muted max-w-sm">{hint}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export function Modal({ open, onClose, title, children, footer, width = 'max-w-md' }:
  { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: string }) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px] no-drag" onMouseDown={onClose}>
      <div className={clsx('w-full rounded-xl border border-border bg-surface shadow-2xl', width)} onMouseDown={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="font-semibold">{title}</h3>
          <IconButton label="Close" onClick={onClose}><X size={16} /></IconButton>
        </header>
        <div className="p-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 px-4 py-3 border-t border-border">{footer}</footer>}
      </div>
    </div>
  )
}

export function Spinner({ className }: { className?: string }) {
  return <span className={clsx('inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent', className)} />
}
