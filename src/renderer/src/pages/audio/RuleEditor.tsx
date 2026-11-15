/** One rule: its reference recordings, their settings, and trying the rule on a recording. */
import { clsx } from 'clsx'
import { ArrowLeft, AudioLines, Download, RotateCcw, Save, Trash2, Undo2, WandSparkles, Waves, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { AudioAnalysis, AudioLook } from '@shared/types'
import { KNOBS, MODULE_ORDER, MODULE_TITLES, SIGNAL_FLOW, countOn, defaultModules, toLook, type ModuleKey, type Modules, type StripKey } from '@core/audio-modules'
import { MAX_REFERENCES, type AudioRule } from '@core/audio-rules'
import type { ReportRow, SuggestNote } from '@core/audio-steer'
import { validateLook } from '../../../../plugins/audio/look'
import { Badge, Button, Select, Empty } from '@/components/ui'
import { errText, useStore } from '@/store'
import { DEFAULT_RULE, Reasons, ResultTable, Segmented, Stat, db, fmtTime, newRuleId, shortName } from './shared'
import { EqEditor } from './EqEditor'
import { KnobRow, ModuleCard } from './Strip'
import { Workbench } from './Workbench'

export function RuleEditor({ initialKey, onBack }: { initialKey: string; onBack: () => void }) {
  const library = useStore((s) => s.library)
  const notify = useStore((s) => s.notify)
  const call = useStore((s) => s.call)
  const saving = useStore((s) => !!s.busy['audioRule'])
  const records = library.records
  const rulesState = library.audioRules
  const reciters = library.reciters

  // ── which rule ──
  const [ruleKey, setRuleKey] = useState<string>(initialKey)
  const reciterKey = ruleKey === DEFAULT_RULE ? null : ruleKey
  const stored = rulesState.rules.find((r) => r.reciterKey === reciterKey) ?? null
  const storedJson = JSON.stringify(stored)
  const blank = (): AudioRule => ({ id: newRuleId(), reciterKey, refs: [], target: null })
  const [draft, setDraft] = useState<AudioRule>(() => stored ?? blank())
  const [refIndex, setRefIndex] = useState(0)
  const [mode, setMode] = useState<'setup' | 'try'>('setup')
  const pool = useMemo(() => records.filter((r) => reciterKey === null || r.reciterKey === reciterKey), [records, reciterKey])
  const [tryId, setTryId] = useState('')
  const [tryModules, setTryModules] = useState<Modules>(() => defaultModules())
  const [start, setStart] = useState(60)
  const [analysis, setAnalysis] = useState<AudioAnalysis | null>(null)
  const [analysing, setAnalysing] = useState(false)
  // Auto-set / rule try-out: what it decided (with the reasons) and the settings from before, so one click undoes it
  const [auto, setAuto] = useState<{ how: string; report: ReportRow[] | null; findings: string[]; notes: SuggestNote[]; failed: { file: string; message: string }[]; before: Modules } | null>(null)
  const [autoBusy, setAutoBusy] = useState<{ done: number; total: number; stage?: string } | null>(null)
  const [saveStage, setSaveStage] = useState<string | null>(null)

  // the stored rule changed (saved, imported, deleted) or another rule was chosen: start again from what is stored
  useEffect(() => {
    setDraft(stored ? (JSON.parse(storedJson) as AudioRule) : blank())
    setRefIndex(0); setAuto(null)
  }, [ruleKey, storedJson])  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!pool.some((r) => r.id === tryId)) setTryId(pool[0]?.id ?? '') }, [pool, tryId])

  const ref = draft.refs[refIndex]
  const first = draft.refs[0]
  // a reference that follows the first one: ask what the first one's settings come to on this recording
  const followKey = mode === 'setup' && ref && !ref.modules && first?.modules ? JSON.stringify([first.recordId, ref.recordId, first.modules]) : null
  const [followed, setFollowed] = useState<{ key: string; modules: Modules; result: { how: string; report: ReportRow[] | null; findings: string[]; notes: SuggestNote[] } } | null>(null)
  useEffect(() => {
    if (!followKey || !first?.modules || !ref) return
    let live = true
    window.api.followAudioSettings(first.modules, first.recordId, ref.recordId)
      .then((r) => { if (live) setFollowed({ key: followKey, modules: r.modules, result: { how: r.how, report: r.report, findings: r.findings, notes: r.notes } }) })
      .catch((e) => { if (live) notify('error', errText(e)) })
    return () => { live = false }
  }, [followKey])  // eslint-disable-line react-hooks/exhaustive-deps
  const following = mode === 'setup' && !!ref && !ref.modules
  const followReady = following && followed?.key === followKey
  const modules: Modules = mode === 'try' ? tryModules : !ref ? defaultModules() : ref.modules ?? (followReady ? followed!.modules : defaultModules())
  const editable = mode === 'try' ? !!tryId : !!ref && (!following || followReady)
  const setModules = (next: Modules | ((m: Modules) => Modules)) => {
    if (!editable) return
    const value = typeof next === 'function' ? next(modules) : next
    if (mode === 'try') { setTryModules(value); return }
    // editing a reference that follows the first one gives it settings of its own
    setDraft((d) => ({ ...d, refs: d.refs.map((r, i) => (i === refIndex ? { ...r, modules: value } : r)) }))
  }

  const recordId = mode === 'try' ? tryId : ref?.recordId ?? ''
  const record = records.find((r) => r.id === recordId)
  useEffect(() => { setAnalysis(null); setAuto(null); setStart(60) }, [recordId, mode])

  const look: AudioLook = useMemo(() => toLook(modules), [modules])
  const validation = useMemo(() => validateLook(look), [look])
  const errors = validation.ok ? [] : validation.errors
  const on = countOn(modules)
  const strip = (key: StripKey) => modules[key] as Record<string, unknown> & { on: boolean }
  const update = <K extends ModuleKey>(key: K, patch: Partial<Modules[K]>) => setModules((m) => ({ ...m, [key]: { ...m[key], ...patch } }))

  const bare = (r: AudioRule | null) => (r ? JSON.stringify({ label: r.label ?? '', refs: r.refs }) : JSON.stringify({ label: '', refs: [] }))
  const dirty = bare(draft) !== bare(stored)
  const name = (id: string) => records.find((r) => r.id === id)?.fileName ?? `${id} (missing)`
  const short = (id: string) => { const r = records.find((x) => x.id === id); return r ? shortName(r.fileName, reciterKey === null ? '' : r.reciterFolder) : `${id} (missing)` }
  const reciterName = reciterKey === null ? 'every reciter without a rule of their own' : reciters.find((r) => r.key === reciterKey)?.folder ?? reciterKey

  const addRef = (id: string) => {
    if (!id || draft.refs.length >= MAX_REFERENCES) return
    setDraft((d) => ({ ...d, refs: [...d.refs, { recordId: id, modules: d.refs.length === 0 ? defaultModules() : null }] }))
    setRefIndex(draft.refs.length); setMode('setup')
  }
  const removeRef = (i: number) => {
    setDraft((d) => {
      const refs = d.refs.filter((_, k) => k !== i)
      // the first reference always has settings of its own: a follower promoted to first takes over the old first's
      if (i === 0 && refs[0] && !refs[0].modules) refs[0] = { ...refs[0], modules: d.refs[0]!.modules }
      return { ...d, refs }
    })
    setRefIndex((k) => Math.max(0, k >= i && k > 0 ? k - 1 : k))
  }
  const save = () => void call('audioRule', async () => {
    const off = window.api.on('audioMeasure', (p) => setSaveStage(p.stage ?? null))
    try {
      await window.api.saveAudioRule(draft)
      notify('success', draft.refs.length ? `Rule saved. Its target is the mean of ${draft.refs.length} reference recording${draft.refs.length === 1 ? '' : 's'} after their settings.` : 'Rule saved.')
    } finally { off(); setSaveStage(null) }
  })
  const analyse = () => {
    if (!record) return
    setAnalysing(true)
    window.api.analyseAudio(record.id).then(setAnalysis).catch((e) => notify('error', errText(e))).finally(() => setAnalysing(false))
  }
  /** Setting a rule up: Auto-set applies the default rule to this reference. Trying a rule out: what an upload would get
   *  (the default rule is tried as the default rule, whatever rule the recording's own reciter has). */
  const autoSet = () => {
    if (!record || autoBusy || !editable) return
    setAutoBusy({ done: 0, total: 0 })
    const off = window.api.on('audioMeasure', setAutoBusy)
    const before = modules
    window.api.suggestAudio(record.id, mode === 'try' ? defaultModules() : modules, mode === 'try' && reciterKey !== null ? 'upload' : 'default').then((r) => {
      setAuto((prev) => ({ how: r.how, report: r.report, findings: r.findings, notes: r.notes, failed: r.failed, before: prev?.before ?? before }))   // pressed twice: Undo still goes back to before the first
      setModules(r.modules)
    }).catch((e) => notify('error', errText(e))).finally(() => { off(); setAutoBusy(null) })
  }

  const target = stored?.target ?? null
  const status = dirty
    ? 'Unsaved changes. Saving processes the reference recordings, measures them and stores the mean as this rule’s target.'
    : target ? `Target captured ${new Date(target.capturedAt).toLocaleDateString()} from ${target.count} reference recording${target.count === 1 ? '' : 's'}${stored && stored.refs.length === 0 ? ' (imported; the recordings are not in this library)' : ''}. Every upload of ${reciterName} is steered to it.`
      : reciterKey === null
        ? (library.audioBuiltIn ? `No default rule of your own: the one that comes with the app applies (made from ${library.audioBuiltIn.count} recordings). Add reference recordings here to replace it.` : 'No default rule.')
        : `No rule for ${reciterName} yet, so the default rule applies to their recordings. Add a reference recording to make one.`

  return (
    <div className="flex h-full flex-col">
      <div className="drag h-13 flex shrink-0 items-center gap-3 border-b border-border px-6">
        <Button size="sm" variant="ghost" className="no-drag" onClick={() => { if (!dirty || window.confirm('Leave without saving this rule’s changes?')) onBack() }} title="Back to the list of audio rules"><ArrowLeft size={14} /> Audio rules</Button>
        <Select value={ruleKey} onChange={(e) => { if (!dirty || window.confirm('Switch rule without saving this one’s changes?')) setRuleKey(e.target.value) }} className="no-drag h-8 max-w-[260px] text-[13px]" title="Rules match by reciter. A reciter without a rule gets the default rule.">
          <option value={DEFAULT_RULE}>Default rule{rulesState.rules.some((r) => r.reciterKey === null) ? '' : ' (built in)'}</option>
          {reciters.map((r) => <option key={r.key} value={r.key}>{r.folder}{rulesState.rules.some((x) => x.reciterKey === r.key) ? '' : ' (no rule: default applies)'}</option>)}
        </Select>
        <div className="no-drag ml-auto flex shrink-0 items-center gap-2">
          <Button size="sm" variant="ghost" disabled={!stored?.target || dirty} onClick={() => void call('audioExport', async () => { const r = await window.api.exportAudioRule(stored!.id); if (r) notify('success', `Rule exported to ${r.path}`) })} title="Export this rule as a file. The target travels in the file, so it works on a computer without these recordings."><Download size={13} /> Export</Button>
          <Button size="sm" variant="ghost" disabled={!stored} onClick={() => { if (window.confirm('Delete this rule? Its settings and target are discarded. Export it first if you may want it back.')) void call('audioDelete', async () => { await window.api.deleteAudioRule(stored!.id); onBack() }) }} title={reciterKey === null ? 'Remove your default rule: the one that comes with the app applies again' : 'Remove this rule: the default rule applies to this reciter again'}><Trash2 size={13} /> Delete</Button>
          <Button size="sm" disabled={!dirty || saving || errors.length > 0 || (draft.refs.length === 0 && !stored?.target)} onClick={save}><Save size={13} /> {saving ? saveStage ?? 'Saving…' : 'Save rule'}</Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        {/* left: the channel strip, simplest module first */}
        <aside className="w-[clamp(300px,34%,420px)] shrink-0 overflow-y-auto border-r border-border">
          <div className="border-b border-border px-4 py-3 text-[11px] leading-snug text-muted">
            <div className="flex items-center gap-2"><Badge tone={on ? 'info' : 'muted'} className="whitespace-nowrap">{on ? `${on} module${on === 1 ? '' : 's'} on` : 'no processing'}</Badge>
              <button type="button" className="text-muted hover:text-text disabled:opacity-40" disabled={!on || !editable} onClick={() => setModules(defaultModules())} title="Switch every module off and return every knob to its default"><RotateCcw size={11} className="inline" /> reset all</button></div>
            <div className="mt-1.5"><span className="font-medium text-text">Signal flow:</span> {SIGNAL_FLOW}.</div>
            <div className="mt-1">{mode === 'try' ? 'These are the settings the rule gives this recording. Changes here are for listening only and are not saved.'
              : !ref ? 'Add a reference recording on the right to start.'
              : following ? (followReady ? `Reference ${refIndex + 1} follows reference 1: it has been auto-set to sound like reference 1 does after its settings (tone, evenness, static, ring, room, loudness). Change anything and this reference keeps settings of its own.` : 'Auto-setting this recording to sound like reference 1 does after its settings. This takes 10 to 30 seconds…')
              : `Settings of reference ${refIndex + 1}. The rule’s target is how the references sound after their settings.`}</div>
          </div>
          <div className={clsx(!editable && 'pointer-events-none opacity-50')}>
            {MODULE_ORDER.map((key) => (
              <ModuleCard key={key} title={MODULE_TITLES[key]} on={strip(key).on} onToggle={(v) => update(key, { on: v } as Partial<Modules[typeof key]>)}
                onReset={() => setModules((m) => ({ ...m, [key]: { ...defaultModules()[key], on: (m[key] as { on: boolean }).on } }))}
                changed={JSON.stringify({ ...modules[key], on: false }) !== JSON.stringify({ ...defaultModules()[key], on: false })}>
                {KNOBS[key].map((k) => (
                  <KnobRow key={k.key} knob={k} value={strip(key)[k.key]} disabled={!strip(key).on}
                    error={errors.find((e) => e.path.includes(`.${k.key}`) && e.path.includes(`[${look.chain.findIndex((st) => st.id === key)}]`))?.message}
                    onChange={(v) => update(key, { [k.key]: v } as Partial<Modules[typeof key]>)} />
                ))}
              </ModuleCard>
            ))}
          </div>
        </aside>

        {/* right: the rule's references (or a recording to try it on), A/B player, EQ */}
        <main className="min-w-0 flex-1 overflow-y-auto p-5 space-y-4">
          <div className="rounded-xl border border-border bg-surface px-4 py-3 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <Segmented label="What the editor shows" value={mode} onChange={(m) => setMode(m)} options={[
                { value: 'setup', label: 'Set up the rule', title: 'Choose up to five reference recordings and dial in their settings' },
                { value: 'try', label: 'Try it on a recording', title: 'Hear what the saved rule does to any recording, exactly as an upload would get it' },
              ]} />
              <span className="w-full text-[11.5px] leading-snug text-muted">{status}</span>
            </div>
            {mode === 'setup' ? (
              <div className="mt-3 border-t border-border pt-3">
                <div className="mb-1.5 text-muted">Reference recordings for {reciterName} ({draft.refs.length} of {MAX_REFERENCES}). Edit the first. The others follow it: each is auto-set to sound like the first does after its settings, until you change it. The target is the mean of all of them.</div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {draft.refs.map((r, i) => (
                    <span key={r.recordId} className={clsx('inline-flex max-w-full items-center gap-1 rounded-lg border px-2 py-1', i === refIndex ? 'border-accent bg-accent/10' : 'border-border')}>
                      <button type="button" className="min-w-0 truncate text-left no-drag" onClick={() => setRefIndex(i)} title={name(r.recordId)}>
                        <span className="font-medium">{i + 1}.</span> {short(r.recordId)} <span className="text-muted">{i === 0 ? '· sets the sound' : r.modules ? '· own settings' : '· follows 1'}</span>
                      </button>
                      {i > 0 && r.modules && <button type="button" className="text-muted hover:text-text no-drag" onClick={() => setDraft((d) => ({ ...d, refs: d.refs.map((x, k) => (k === i ? { ...x, modules: null } : x)) }))} title="Drop this reference’s own settings and follow reference 1 again"><Undo2 size={12} /></button>}
                      <button type="button" className="text-muted hover:text-err no-drag" onClick={() => removeRef(i)} title="Remove from the rule"><X size={12} /></button>
                    </span>
                  ))}
                  {draft.refs.length < MAX_REFERENCES && (
                    <Select value="" onChange={(e) => addRef(e.target.value)} className="h-7.5 max-w-[240px] text-xs" title="Add a reference recording">
                      <option value="">+ Add a recording…</option>
                      {pool.filter((r) => !draft.refs.some((x) => x.recordId === r.id)).map((r) => <option key={r.id} value={r.id}>{reciterKey === null && r.reciterFolder ? `${r.reciterFolder} / ` : ''}{r.fileName}</option>)}
                    </Select>
                  )}
                </div>
              </div>
            ) : (
              <div className="mt-3 flex flex-wrap items-end gap-3 border-t border-border pt-3">
                <label className="min-w-0 flex-1 text-muted">
                  <div className="mb-1">Recording to try the rule on</div>
                  <Select value={tryId} onChange={(e) => { setTryId(e.target.value); setTryModules(defaultModules()) }} className="h-8 w-full text-[13px]">
                    {pool.map((r) => <option key={r.id} value={r.id}>{reciterKey === null && r.reciterFolder ? `${r.reciterFolder} / ` : ''}{r.fileName}</option>)}
                  </Select>
                </label>
                {dirty && <span className="pb-1.5 text-warn">Save the rule first: this uses the saved one.</span>}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={!record || !!autoBusy || !editable || (mode === 'try' && dirty)} onClick={autoSet}
              title={mode === 'try' ? 'Measures this recording and steers it to the rule, exactly as an upload would: tone, evenness, static, ringing after “s” sounds, loudness. Takes 10 to 30 seconds.' : 'A starting point: sets every module on this reference from the default rule. Then adjust by ear. Takes 10 to 30 seconds.'}>
              <WandSparkles size={13} /> {autoBusy ? (autoBusy.total ? `Measuring ${autoBusy.done}/${autoBusy.total}…` : autoBusy.stage ?? 'Measuring…') : mode === 'try' ? 'Apply the rule' : 'Auto-set'}</Button>
            <Button size="sm" variant="ghost" disabled={!record || analysing} onClick={analyse} title="Measure the whole recording: loudness, peaks, hiss, rumble, clipping"><Waves size={13} /> {analysing ? 'Analysing…' : analysis ? 'Re-analyse' : 'Analyse recording'}</Button>
          </div>
          {analysis && (
            <div className="@container rounded-xl border border-border bg-surface px-4 py-3 text-xs"><div className="grid grid-cols-2 gap-x-6 gap-y-3 @lg:grid-cols-4">
              <Stat label="Length" value={fmtTime(analysis.durationSec)} hint={`${Math.round(analysis.sampleRate / 1000)} kHz · ${analysis.channels === 1 ? 'mono' : analysis.channels === 2 ? 'stereo' : `${analysis.channels} ch`}`} />
              <Stat label="Loudness" value={`${analysis.lufs.toFixed(1)} LUFS`} hint={`range ${analysis.lra.toFixed(1)} LU`} title="Integrated loudness of the whole recording, and how much it varies (loudness range)." />
              <Stat label="True peak" value={db(analysis.truePeak, 'dBTP')} hint={analysis.clipped ? 'clipped' : `${analysis.hotSamplesPct.toFixed(3)} % near full scale`} tone={analysis.clipped ? 'err' : undefined} title="The highest inter-sample peak. A little above 0 on a decoded AAC file is normal; clipping shows as a large share of samples near full scale." />
              <Stat label="Hiss · rumble" value={`${analysis.hissDb.toFixed(0)} · ${analysis.rumbleDb.toFixed(0)} dB`} hint="below the voice" title="Background hiss and low rumble, measured relative to the voice. Lower (more negative) is cleaner." />
            </div>
              {analysis.hints.length > 0 && <div className="mt-3 border-t border-border pt-2 text-[11px] text-muted">{analysis.hints.join(' · ')}</div>}
            </div>
          )}
          {!auto && followReady && followed && (
            <div className="rounded-xl border border-border bg-surface px-4 py-3 text-xs">
              <div><b>Follows reference 1.</b> <span className="text-muted">{followed.result.how.charAt(0).toUpperCase() + followed.result.how.slice(1)}. This is how close it gets; change any setting to give this reference settings of its own.</span></div>
              {followed.result.report && <ResultTable rows={followed.result.report} targetLabel="Reference 1" />}
              <Reasons notes={followed.result.notes} />
            </div>
          )}
          {auto && (
            <div className="rounded-xl border border-border bg-surface px-4 py-3 text-xs">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1"><b>{mode === 'try' ? 'Rule applied.' : 'Auto-set done.'}</b> <span className="text-muted">{auto.how.charAt(0).toUpperCase() + auto.how.slice(1)}. {mode === 'try' ? 'This is what an upload of this recording gets.' : 'Nothing is saved until you press Save rule.'}</span></div>
                <Button size="sm" variant="ghost" onClick={() => { setModules(auto.before); setAuto(null) }} title="Put the strip back to how it was before"><Undo2 size={13} /> Undo</Button>
                <button type="button" className="text-muted hover:text-text no-drag" onClick={() => setAuto(null)} title="Hide (keeps the settings)"><X size={14} /></button>
              </div>
              {auto.report && <ResultTable rows={auto.report} targetLabel="Rule’s target" />}
              {auto.findings.length > 0 && <div className="mt-2 border-t border-border pt-2 text-[11.5px] text-warn">{auto.findings.join(' ')}</div>}
              <Reasons notes={auto.notes} />
              {auto.failed.length > 0 && <div className="mt-2 border-t border-border pt-2 text-[11px] text-warn">Could not be read: {auto.failed.map((f) => `${f.file} (${f.message})`).join(' · ')}</div>}
            </div>
          )}
          {errors.length > 0 && (
            <div className="rounded-xl border border-err/40 bg-err/6 px-4 py-3 text-xs"><b>The plugin rejects some values:</b> {errors.map((e) => `${e.path}: ${e.message}`).join(' · ')}</div>
          )}
          {!record ? <Empty icon={<AudioLines size={28} />} title={mode === 'setup' ? 'Add a reference recording' : 'Choose a recording'} hint={mode === 'setup' ? (reciterKey === null ? 'Pick a recording that sounds the way every reciter without their own rule should, dial it in, then save. Until then the rule that comes with the app applies.' : 'Pick one of this reciter’s best recordings above, dial in how it should sound, then save. Every upload is steered to that sound.') : undefined} />
            : <Workbench key={record.id} recordId={record.id} look={look} lookOk={validation.ok} winStart={start} onWinStart={(s) => setStart((p) => (Math.abs(p - s) < 0.01 ? p : s))} />}
          <div className={clsx(!editable && 'pointer-events-none opacity-50')}><EqEditor eq={modules.eq} onChange={(eq) => setModules((m) => ({ ...m, eq }))} /></div>
        </main>
      </div>
    </div>
  )
}
