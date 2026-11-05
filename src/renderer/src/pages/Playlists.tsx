import { clsx } from 'clsx'
import { Plus, RefreshCw, Trash2, ListMusic, Tag, Pencil, X, AlertTriangle } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Condition, ConditionKind, KeywordDef, PlaylistRule, Privacy, TokenValidation } from '@shared/types'
import { PRAYERS } from '@core/prayers'
import { DEFAULT_SURAHS } from '@core/surahs'
import { KIND_LABEL, MAX_CONDITIONS, describeRule, matchesRule, validateRule } from '@core/rules'
import { Badge, Button, Card, Empty, IconButton, Input, Select, Spinner, Switch } from '@/components/ui'
import { useBusy, useStore } from '@/store'

const SURAH_KEYS = Object.keys(DEFAULT_SURAHS).sort()
const KINDS = Object.keys(KIND_LABEL) as ConditionKind[]

export default function Playlists() {
  const library = useStore((s) => s.library)
  const health = useStore((s) => s.health)
  const call = useStore((s) => s.call)
  const refreshing = useBusy('playlists')
  const [newTitle, setNewTitle] = useState('')
  const [newPrivacy, setNewPrivacy] = useState<Privacy>('public')
  const connected = !!health?.youtube.connected
  const create = () => call('create', async () => { await window.api.createPlaylist(newTitle, newPrivacy); setNewTitle('') }, { success: 'Playlist created' })

  return (
    <div className="h-full overflow-auto">
      <div className="drag h-13 flex items-center px-6 border-b border-border"><h1 className="font-semibold">Playlists</h1></div>
      <div className="grid grid-cols-[300px_minmax(0,1fr)] gap-5 p-6 max-w-6xl">
        <div className="space-y-4">
          <Card title="Your channel" subtitle={`${library.playlists.length} playlist${library.playlists.length === 1 ? '' : 's'}`}
            actions={<IconButton label="Refresh from YouTube" disabled={!connected || refreshing} onClick={() => void call('playlists', () => window.api.refreshPlaylists())}>{refreshing ? <Spinner /> : <RefreshCw size={14} />}</IconButton>}>
            {!connected ? <p className="text-xs text-muted">Connect Google in Settings to load your playlists.</p>
              : library.playlists.length === 0 ? <p className="text-xs text-muted">No playlists yet — create one below or refresh.</p>
              : (
                <ul className="divide-y divide-border/70 -mx-1 max-h-[40vh] overflow-auto">
                  {library.playlists.map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-2 px-1 py-2 text-xs">
                      <button className="truncate text-left hover:underline" onClick={() => void window.api.openExternal(`https://www.youtube.com/playlist?list=${p.id}`)}>{p.title}</button>
                      <span className="text-muted shrink-0 tabular-nums">{p.itemCount ?? '–'}{p.privacy && p.privacy !== 'public' ? ` · ${p.privacy}` : ''}</span>
                    </li>
                  ))}
                </ul>
              )}
          </Card>
          <Card title="New playlist">
            <div className="space-y-2">
              <Input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="e.g. Abdullah Mousa — Taraweeh" disabled={!connected} />
              <div className="flex gap-2">
                <Select value={newPrivacy} onChange={(e) => setNewPrivacy(e.target.value as Privacy)} className="flex-1" disabled={!connected}>
                  <option value="public">Public</option><option value="unlisted">Unlisted</option><option value="private">Private</option>
                </Select>
                <Button variant="primary" onClick={create} disabled={!connected || !newTitle.trim() || useStore.getState().busy['create']}><Plus size={14} /> Create</Button>
              </div>
            </div>
          </Card>
          <KeywordsCard />
        </div>
        <RulesByPlaylist />
      </div>
    </div>
  )
}

// ── Rules grouped by playlist ────────────────────────────────────────────────

function RulesByPlaylist() {
  const library = useStore((s) => s.library)
  const call = useStore((s) => s.call)
  const notify = useStore((s) => s.notify)
  const [rules, setRules] = useState<PlaylistRule[]>(library.rules)
  const [addFor, setAddFor] = useState('')
  const dirty = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => { if (!dirty.current) setRules(library.rules) }, [library.rules])

  const errors = useMemo(() => new Map(rules.map((r) => [r.id, validateRule(r)])), [rules])
  const allValid = [...errors.values()].every((e) => e.length === 0)

  const update = (next: PlaylistRule[]) => {
    setRules(next); dirty.current = true
    if (timer.current) clearTimeout(timer.current)
    // only persist when every rule is valid — the main process refuses invalid rules
    if (next.every((r) => validateRule(r).length === 0)) {
      timer.current = setTimeout(() => { dirty.current = false; void call('rules', () => window.api.setRules(next)) }, 500)
    }
  }
  const patch = (id: string, p: Partial<PlaylistRule>) => update(rules.map((r) => (r.id === id ? { ...r, ...p } : r)))
  const remove = (id: string) => update(rules.filter((r) => r.id !== id))
  const addRule = (playlistId: string) => {
    if (!playlistId) return
    update([...rules, { id: crypto.randomUUID(), playlistId, enabled: true, conditions: [{ kind: 'reciter', value: library.reciters[0]?.folder ?? '', negate: false }] }])
    setAddFor('')
  }

  const plName = (id: string) => library.playlists.find((p) => p.id === id)?.title ?? `(unknown playlist ${id.slice(0, 8)}…)`
  const countFor = (rule: PlaylistRule) => library.records.filter((r) => matchesRule({ ...rule, enabled: true }, { reciter: r.reciterKey, tokens: r.tokens })).length
  const totalFor = (playlistId: string) => library.records.filter((r) => r.playlists.auto.includes(playlistId)).length

  const groups = useMemo(() => {
    const m = new Map<string, PlaylistRule[]>()
    for (const r of rules) (m.get(r.playlistId) ?? m.set(r.playlistId, []).get(r.playlistId)!).push(r)
    return [...m.entries()].sort((a, b) => plName(a[0]).localeCompare(plName(b[0])))
  }, [rules, library.playlists])

  return (
    <div className="space-y-4">
      <Card title="Routing rules" subtitle="A recording is added to a playlist when ALL conditions of any one of its rules are true. Rules never cancel each other — to keep something out, say so with “is not”. Changes apply to future uploads only."
        actions={
          <div className="flex items-center gap-2">
            {!allValid && <Badge tone="err"><AlertTriangle size={11} /> unsaved — fix errors</Badge>}
            <Select value={addFor} onChange={(e) => addRule(e.target.value)} className="h-8 text-xs">
              <option value="">+ Add rule for playlist…</option>
              {library.playlists.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
            </Select>
          </div>
        }>
        {groups.length === 0 ? (
          <Empty icon={<ListMusic size={28} />} title="No rules yet"
            hint={<>Example: playlist <i>Abdullah Mousa</i> ← Reciter is Abdullah Al Mousa · Prayer <b>is not</b> Taraweeh. Playlist <i>Abdullah Mousa Taraweeh</i> ← Reciter is Abdullah Al Mousa · Prayer is Taraweeh.</>}
            action={library.playlists[0] ? <Button variant="primary" size="sm" onClick={() => addRule(library.playlists[0]!.id)}><Plus size={14} /> Add your first rule</Button> : null} />
        ) : (
          <div className="space-y-4">
            {groups.map(([playlistId, list]) => (
              <section key={playlistId} className="rounded-xl border border-border overflow-hidden">
                <header className="flex items-center gap-3 bg-surface-2/60 px-3 py-2">
                  <ListMusic size={14} className="text-accent" />
                  <div className="font-medium text-[13px] truncate">{plName(playlistId)}</div>
                  <span className="ml-auto text-xs text-muted tabular-nums">{totalFor(playlistId)} recording{totalFor(playlistId) === 1 ? '' : 's'} now</span>
                  <Button size="sm" variant="ghost" onClick={() => addRule(playlistId)}><Plus size={13} /> rule</Button>
                </header>
                <div className="divide-y divide-border/70">
                  {list.map((rule) => (
                    <RuleEditor key={rule.id} rule={rule} errors={errors.get(rule.id) ?? []} count={countFor(rule)}
                      onChange={(p) => patch(rule.id, p)} onDelete={() => { remove(rule.id); notify('info', 'Rule removed') }} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
        <datalist id="surah-keys">{SURAH_KEYS.map((k) => <option key={k} value={k} />)}</datalist>
      </Card>
    </div>
  )
}

function RuleEditor({ rule, errors, count, onChange, onDelete }: { rule: PlaylistRule; errors: string[]; count: number; onChange: (p: Partial<PlaylistRule>) => void; onDelete: () => void }) {
  const library = useStore((s) => s.library)
  const [editLabel, setEditLabel] = useState(false)
  const [label, setLabel] = useState(rule.label ?? '')
  const setCond = (i: number, c: Partial<Condition>) => onChange({ conditions: rule.conditions.map((x, j) => (j === i ? { ...x, ...c } : x)) })
  const removeCond = (i: number) => onChange({ conditions: rule.conditions.filter((_, j) => j !== i) })
  const addCond = () => onChange({ conditions: [...rule.conditions, { kind: 'prayer', value: PRAYERS[0]!, negate: false }] })

  return (
    <div className={clsx('px-3 py-2.5 space-y-2', !rule.enabled && 'opacity-60')}>
      <div className="flex items-center gap-2">
        <Switch checked={rule.enabled} onChange={(v) => onChange({ enabled: v })} label="Enabled" />
        {editLabel ? (
          <Input value={label} onChange={(e) => setLabel(e.target.value)} className="h-7 text-xs flex-1" placeholder="Custom name (leave empty for the automatic one)" autoFocus
            onBlur={() => { onChange({ label: label.trim() || undefined }); setEditLabel(false) }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur() }} />
        ) : (
          <button className="min-w-0 flex-1 truncate text-left text-[13px] hover:underline decoration-dotted" title={describeRule({ conditions: rule.conditions })} onClick={() => setEditLabel(true)}>
            {describeRule(rule)} <Pencil size={11} className="inline text-muted ml-1" />
          </button>
        )}
        {rule.origin === 'reciter-added' && <Badge>created with the reciter</Badge>}
        <Badge tone={count ? 'info' : 'muted'} className="tabular-nums">{count} match{count === 1 ? '' : 'es'}</Badge>
        <IconButton label="Delete rule" className="h-7 w-7" onClick={onDelete}><Trash2 size={13} /></IconButton>
      </div>
      <div className="space-y-1.5 pl-1">
        {rule.conditions.map((c, i) => (
          <div key={i} className="grid grid-cols-[52px_84px_120px_minmax(0,1fr)_28px] items-center gap-1.5">
            <span className="text-[11px] text-muted text-right pr-1">{i === 0 ? 'when' : 'and'}</span>
            <Select value={c.negate ? 'not' : 'is'} onChange={(e) => setCond(i, { negate: e.target.value === 'not' })} className="h-7.5 text-xs">
              <option value="is">is</option><option value="not">is not</option>
            </Select>
            <Select value={c.kind} onChange={(e) => setCond(i, { kind: e.target.value as ConditionKind, value: '' })} className="h-7.5 text-xs">
              {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </Select>
            <ValueInput c={c} onChange={(value) => setCond(i, { value })} reciters={library.reciters.map((r) => r.folder)} keywords={library.keywords} />
            <IconButton label="Remove condition" className="h-7 w-7" onClick={() => removeCond(i)} disabled={rule.conditions.length === 1}><X size={12} /></IconButton>
          </div>
        ))}
        {rule.conditions.length < MAX_CONDITIONS && (
          <button className="text-[11px] text-accent hover:underline pl-[60px]" onClick={addCond}>+ add condition ({MAX_CONDITIONS - rule.conditions.length} left)</button>
        )}
      </div>
      {errors.length > 0 && <div className="text-[11px] text-err pl-1">{errors[0]}</div>}
      {errors.length === 0 && rule.conditions.some((c) => (c.kind === 'surah' || c.kind === 'keyword') && c.negate) && (
        <div className="text-[11px] text-muted pl-1">“is not” on a surah/keyword means: none of the recording's surahs/keywords is that one.</div>
      )}
    </div>
  )
}

function ValueInput({ c, onChange, reciters, keywords }: { c: Condition; onChange: (v: string) => void; reciters: string[]; keywords: KeywordDef[] }) {
  const cls = 'h-7.5 text-xs w-full'
  switch (c.kind) {
    case 'reciter':
      return <Select value={c.value} onChange={(e) => onChange(e.target.value)} className={cls}><option value="">choose reciter…</option>{reciters.map((r) => <option key={r} value={r}>{r}</option>)}{c.value && !reciters.includes(c.value) && <option value={c.value}>⚠ {c.value} (folder not found)</option>}</Select>
    case 'prayer':
      return <Select value={c.value} onChange={(e) => onChange(e.target.value)} className={cls}><option value="">choose prayer…</option>{PRAYERS.map((p) => <option key={p} value={p}>{p}</option>)}</Select>
    case 'surah':
      return <Input list="surah-keys" value={c.value} onChange={(e) => onChange(e.target.value)} placeholder="e.g. baqarah" className={cls} />
    case 'keyword':
      return <Select value={c.value} onChange={(e) => onChange(e.target.value)} className={cls}><option value="">{keywords.length ? 'choose keyword…' : 'no keywords registered yet'}</option>{keywords.map((k) => <option key={k.name} value={k.name}>{k.name}</option>)}</Select>
  }
}

// ── Keywords: vocabulary only ────────────────────────────────────────────────

function KeywordsCard() {
  const library = useStore((s) => s.library)
  const call = useStore((s) => s.call)
  const [draft, setDraft] = useState('')
  const [check, setCheck] = useState<TokenValidation | null>(null)
  useEffect(() => {
    if (!draft.trim()) { setCheck(null); return }
    let live = true
    const t = setTimeout(() => void window.api.validateToken('keyword', draft).then((v) => { if (live) setCheck(v) }), 250)
    return () => { live = false; clearTimeout(t) }
  }, [draft])
  const save = (next: KeywordDef[]) => void call('keywords', () => window.api.setKeywords(next))
  const add = () => { if (!check?.ok) return; save([...library.keywords, { name: draft.trim() }]); setDraft('') }
  const uses = (name: string) => library.rules.filter((r) => r.conditions.some((c) => c.kind === 'keyword' && c.value.toLowerCase() === name.toLowerCase())).length
  const hits = (name: string) => library.records.filter((r) => r.tokens.keywords.some((k) => k.toLowerCase() === name.toLowerCase())).length
  const draftHits = draft.trim() ? library.records.filter((r) => r.tokens.leftovers.some((l) => l.toLowerCase() === draft.trim().toLowerCase())).length : 0

  return (
    <Card title="Keywords" subtitle="Words the parser should recognise in filenames. Use them as conditions in rules.">
      <div className="flex gap-2 items-start">
        <div className="flex-1">
          <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="e.g. Final, Outside" onKeyDown={(e) => { if (e.key === 'Enter') add() }} />
          {check?.error && <div className="text-xs text-err mt-1">{check.error}</div>}
          {check?.ok && check.warning && <div className="text-xs text-warn mt-1">{check.warning}</div>}
          {check?.ok && draftHits > 0 && <div className="text-xs text-ok mt-1">Will fix {draftHits} flagged recording{draftHits === 1 ? '' : 's'}</div>}
        </div>
        <Button variant="primary" onClick={add} disabled={!check?.ok}><Plus size={14} /></Button>
      </div>
      {library.keywords.length > 0 && (
        <ul className="mt-3 space-y-1">
          {library.keywords.map((k) => (
            <li key={k.name} className="flex items-center gap-2 text-xs">
              <Badge tone="warn"><Tag size={10} /> {k.name}</Badge>
              <span className="text-muted">{hits(k.name)} recording{hits(k.name) === 1 ? '' : 's'} · {uses(k.name)} rule{uses(k.name) === 1 ? '' : 's'}</span>
              <IconButton label={uses(k.name) ? 'Used by rules — remove those first' : 'Delete keyword'} className="ml-auto h-6 w-6" disabled={uses(k.name) > 0}
                onClick={() => save(library.keywords.filter((x) => x.name !== k.name))}><Trash2 size={12} /></IconButton>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
