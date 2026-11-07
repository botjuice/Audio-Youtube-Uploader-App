import { useEffect, useState } from 'react'
import type { SurahOption } from '@shared/types'
import { translateSurah } from '@core/surahs'
import { Select } from './ui'

let cache: SurahOption[] | null = null
let inflight: Promise<SurahOption[]> | null = null
/** The 114 surahs (number, Arabic, one clean Latin label), fetched once per session. */
export function useSurahOptions(): SurahOption[] {
  const [opts, setOpts] = useState<SurahOption[]>(cache ?? [])
  useEffect(() => {
    if (cache) return
    inflight ??= window.api.listSurahOptions().then((o) => (cache = o))
    let live = true
    void inflight.then((o) => { if (live) setOpts(o) })
    return () => { live = false }
  }, [])
  return opts
}

/**
 * Surah picker for rule conditions. Shows "N. الفاتحة — Fatiha" and stores the clean Latin label;
 * a value saved with any other spelling still selects the right surah (matched by its Arabic name).
 */
export function SurahSelect({ value, onChange, className }: { value: string; onChange: (v: string) => void; className?: string }) {
  const opts = useSurahOptions()
  const ar = value ? translateSurah(value) : ''
  const current = opts.find((o) => o.ar === ar)
  return (
    <Select value={current ? current.label : value} onChange={(e) => onChange(e.target.value)} className={className}>
      <option value="">choose surah…</option>
      {value && !current && <option value={value}>⚠ {value} (unknown spelling)</option>}
      {opts.map((o) => <option key={o.n} value={o.label}>{o.n}. {o.ar} — {o.label}</option>)}
    </Select>
  )
}
