/** The Audio rules library: one card per rule, the default rule last. */
import { AudioLines, Download, Trash2, Upload } from 'lucide-react'
import { type AudioRule } from '@core/audio-rules'
import { MEASURE_BANDS } from '../../../../plugins/audio/types'
import { Badge, Button, IconButton, Select, Switch, Empty } from '@/components/ui'
import { useStore } from '@/store'
import { DEFAULT_RULE, shortName } from './shared'

/** A target's tone as a small curve (level per band, low to high), so rules can be told apart at a glance. */
function ToneCurve({ tone }: { tone: number[] }) {
  const pts = tone.map((v, b) => ({ f: MEASURE_BANDS[b]!, v })).filter((p) => p.f >= 100 && p.f <= 10000)
  if (pts.length < 2) return null
  const top = Math.max(...pts.map((p) => p.v)), bottom = top - 40
  const x = (f: number) => (Math.log(f / 100) / Math.log(100)) * 300, y = (v: number) => 8 + ((top - Math.max(bottom, v)) / (top - bottom)) * 84
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.f).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ')
  return (
    <svg viewBox="0 0 300 100" preserveAspectRatio="none" className="h-full w-full">
      {[1000].map((f) => <line key={f} x1={x(f)} x2={x(f)} y1="0" y2="100" stroke="currentColor" strokeOpacity="0.12" />)}
      <path d={`${line} L300,100 L0,100 Z`} fill="currentColor" fillOpacity="0.10" />
      <path d={line} fill="none" stroke="currentColor" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

export function RulesLibrary({ onOpen }: { onOpen: (ruleKey: string) => void }) {
  const library = useStore((s) => s.library)
  const notify = useStore((s) => s.notify)
  const call = useStore((s) => s.call)
  const state = library.audioRules
  const reciters = library.reciters
  const own = state.rules.filter((r) => r.reciterKey !== null)
  const def = state.rules.find((r) => r.reciterKey === null) ?? null
  const covered = new Set(own.filter((r) => r.target).map((r) => r.reciterKey))
  const countFor = (key: string | null) => library.records.filter((r) => (key === null ? !r.reciterKey || !covered.has(r.reciterKey) : r.reciterKey === key)).length
  const without = reciters.filter((r) => !own.some((x) => x.reciterKey === r.key))
  const folder = (key: string) => reciters.find((r) => r.key === key)?.folder ?? key
  const name = (id: string) => { const r = library.records.find((x) => x.id === id); return r ? shortName(r.fileName, r.reciterFolder) : `${id} (missing)` }

  const card = (key: string | null, rule: AudioRule | null) => {
    const target = rule?.target ?? null
    const builtIn = key === null && !rule ? library.audioBuiltIn : null
    const tone = target?.tone ?? builtIn?.tone
    const n = countFor(key)
    const applies = key !== null && !target ? 0 : n
    return (
      <section key={key ?? 'default'} className="flex flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-xs">
        <button type="button" onClick={() => onOpen(key ?? DEFAULT_RULE)} title="Click to open this rule" className="group relative block aspect-[3/1] w-full bg-surface-2 text-left text-accent no-drag">
          {tone ? <ToneCurve tone={tone} /> : <div className="absolute inset-0 flex items-center justify-center text-muted"><AudioLines size={26} /></div>}
          <span className="absolute bottom-1 left-2 text-[10.5px] text-muted">{tone ? 'target tone · 100 Hz' : 'no target yet'}</span>
          {tone && <span className="absolute bottom-1 right-2 text-[10.5px] text-muted">10 kHz</span>}
          <span className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 transition-opacity group-hover:opacity-100">
            <span className="inline-flex items-center gap-2 rounded-lg bg-white/95 px-3 py-1.5 text-[13px] font-medium text-slate-900 shadow"><AudioLines size={14} /> Open rule</span>
          </span>
        </button>
        <div className="space-y-2 p-3">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1 truncate text-[13px] font-medium">{key === null ? 'Default rule' : folder(key)}{rule?.label ? ` · ${rule.label}` : ''}</div>
            {key === null && <Badge tone="accent">{rule ? 'default' : 'default · built in'}</Badge>}
            {key !== null && !target && <Badge tone="warn">not saved yet</Badge>}
          </div>
          <div className="flex flex-wrap gap-1">
            {key === null ? <span className="text-xs text-muted">Applies to every reciter without a rule of their own.</span> : <Badge tone="info">Reciter is {folder(key)}</Badge>}
          </div>
          <div className="text-[11.5px] leading-snug text-muted">
            {target ? <>Mean of {target.count} reference recording{target.count === 1 ? '' : 's'}{rule && rule.refs.length ? `: ${rule.refs.map((r) => name(r.recordId)).join(', ')}` : ' (imported; the recordings are not in this library)'}. Loudness {target.lufs.toFixed(1)} LUFS{target.hp > 0 ? `, high-pass ${target.hp} Hz` : ''}. Captured {new Date(target.capturedAt).toLocaleDateString()}.</>
              : builtIn ? <>Comes with the app: the mean of {builtIn.count} recordings after the approved settings. Loudness {builtIn.lufs.toFixed(1)} LUFS, high-pass {builtIn.hp} Hz. Open it to make your own.</>
                : <>Has reference recordings but no target: open it and press Save rule.</>}
          </div>
          <div className="flex items-center gap-2 text-xs text-muted">
            <span className="tabular-nums">{applies} recording{applies === 1 ? '' : 's'} now</span>
            <span className="ml-auto inline-flex items-center gap-0.5">
              {rule?.target && <IconButton label="Export this rule" className="h-7 w-7" onClick={() => void call('audioExport', async () => { const r = await window.api.exportAudioRule(rule.id); if (r) notify('success', `Rule exported to ${r.path}`) })}><Download size={13} /></IconButton>}
              {rule && <IconButton label={key === null ? 'Remove your default rule (the built-in one applies again)' : 'Delete rule (the default rule applies to this reciter again)'} className="h-7 w-7" onClick={() => { if (window.confirm(key === null ? 'Remove your default rule? Its settings and target are discarded and the rule that comes with the app applies again.' : `Delete the rule for ${folder(key)}? Its settings and target are discarded and the default rule applies to this reciter again. Export it first if you may want it back.`)) void call('audioDelete', () => window.api.deleteAudioRule(rule.id)) }}><Trash2 size={13} /></IconButton>}
            </span>
          </div>
        </div>
      </section>
    )
  }

  return (
    <div className="h-full overflow-auto">
      <div className="drag flex h-13 items-center gap-3 border-b border-border px-6">
        <h1 className="shrink-0 whitespace-nowrap font-semibold">Audio rules</h1>
        <span className="min-w-0 truncate text-xs text-muted" title="Each recording is steered to its reciter’s rule; a reciter without one gets the default rule.">A reciter’s own rule wins · otherwise the default rule</span>
        {!state.applyToUploads && <span title="Recordings upload with their original audio until you switch this on."><Badge tone="warn" className="whitespace-nowrap">Off for uploads</Badge></span>}
        <div className="no-drag ml-auto flex shrink-0 items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted" title="When on, every upload first has its audio processed by its reciter’s rule (or the default rule). When off, recordings upload with their original audio.">
            <Switch checked={state.applyToUploads} onChange={(v) => void call('audioApply', () => window.api.setAudioApplyToUploads(v))} label="Use for uploads" /> Use for uploads
          </label>
          <Button size="sm" variant="ghost" onClick={() => void call('audioImport', async () => { const r = await window.api.importAudioRule(); if (r) notify('success', `Rule imported${r.reciterKey ? ` for ${r.reciterKey}` : ' as the default rule'}.`) })} title="Import a rule file. It becomes the rule for its reciter, replacing the one there."><Upload size={13} /> Import</Button>
          <Select value="" onChange={(e) => { if (e.target.value) onOpen(e.target.value) }} disabled={!without.length} className="h-8 max-w-[220px] text-[13px]" title={without.length ? 'Make a rule for a reciter' : 'Every reciter already has a rule'}>
            <option value="">+ New rule for…</option>
            {without.map((r) => <option key={r.key} value={r.key}>{r.folder}</option>)}
          </Select>
        </div>
      </div>
      {!library.records.length ? (
        <div className="p-6"><Empty icon={<AudioLines size={28} />} title="No recordings yet" hint="Add recordings to the library to make audio rules from them." /></div>
      ) : (
        <div className="grid max-w-[1600px] grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-5 p-6">
          {own.map((r) => card(r.reciterKey, r))}
          {card(null, def)}
        </div>
      )}
    </div>
  )
}
