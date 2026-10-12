import type { LibraryRecord, RecordStatus } from '@shared/types'

export type Tone = 'ok' | 'warn' | 'err' | 'info' | 'accent' | 'muted'

export const STATUS_META: Record<RecordStatus, { label: string; tone: Tone }> = {
  ready:    { label: 'Ready',       tone: 'ok' },
  encoded:  { label: 'Rendered',    tone: 'info' },
  fix:      { label: 'Fixable',     tone: 'warn' },
  error:    { label: 'Needs you',   tone: 'err' },
  skipped:  { label: 'Skipped',     tone: 'muted' },
  uploaded: { label: 'Uploaded',    tone: 'accent' },
}

export const isUploadable = (r: LibraryRecord) => (r.status === 'ready' || r.status === 'encoded') && !r.skipped

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const u = ['KB', 'MB', 'GB']
  let i = -1
  do { n /= 1024; i++ } while (n >= 1024 && i < u.length - 1)
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`
}

export function fmtRel(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = (Date.now() - new Date(iso).getTime()) / 1000
  if (d < 60) return 'just now'
  if (d < 3600) return `${Math.floor(d / 60)} min ago`
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`
  return new Date(iso).toLocaleDateString()
}

export function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function fmtUntil(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return 'now'
  const h = Math.floor(ms / 3600_000), m = Math.floor((ms % 3600_000) / 60_000)
  return h ? `${h}h ${m}m` : `${m}m`
}

/** Accepts a YouTube URL or bare 11-char id. */
export function parseVideoId(s: string): string | null {
  const t = s.trim()
  const m = /(?:v=|youtu\.be\/|\/shorts\/|\/live\/)([\w-]{11})/.exec(t)
  if (m) return m[1]!
  return /^[\w-]{11}$/.test(t) ? t : null
}
