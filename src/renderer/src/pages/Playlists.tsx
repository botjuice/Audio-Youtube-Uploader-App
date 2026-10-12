import { Plus, RefreshCw, Trash2, ListMusic } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { PlaylistRule, Privacy, RuleMatch } from '@shared/types'
import { PRAYERS } from '@core/prayers'
import { DEFAULT_SURAHS } from '@core/surahs'
import { matchesRule } from '@core/rules'
import { Badge, Button, Card, Empty, IconButton, Input, Select, Spinner, Switch } from '@/components/ui'
import { useBusy, useStore } from '@/store'

const MATCH_LABEL: Record<RuleMatch, string> = { reciter: 'Reciter is', prayer: 'Prayer is', surah: 'Surah includes', keyword: 'Filename contains' }
const SURAH_KEYS = Object.keys(DEFAULT_SURAHS).sort()

export default function Playlists() {
  const library = useStore((s) => s.library)
  const health = useStore((s) => s.health)
  const call = useStore((s) => s.call)
  const refreshing = useBusy('playlists')
  const [rules, setRules] = useState<PlaylistRule[]>(library.rules)
  const [newTitle, setNewTitle] = useState('')
  const [newPrivacy, setNewPrivacy] = useState<Privacy>('public')
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirty = useRef(false)

  useEffect(() => { if (!dirty.current) setRules(library.rules) }, [library.rules])

  const update = (next: PlaylistRule[]) => {
    setRules(next); dirty.current = true
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => { dirty.current = false; void call('rules', () => window.api.setRules(next)) }, 500)
  }
  const patch = (id: string, p: Partial<PlaylistRule>) => update(rules.map((r) => (r.id === id ? { ...r, ...p } : r)))
  const add = () => update([...rules, { id: crypto.randomUUID(), match: 'keyword', value: '', playlistId: library.playlists[0]?.id ?? '', enabled: true }])
  const remove = (id: string) => update(rules.filter((r) => r.id !== id))

  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const rule of rules) m.set(rule.id, library.records.filter((r) => matchesRule({ ...rule, enabled: true }, { reciterFolder: r.reciterFolder, stem: r.stem, parsed: r.parsed })).length)
    return m
  }, [rules, library.records])

  const create = () => call('create', async () => {
    await window.api.createPlaylist(newTitle, newPrivacy); setNewTitle('')
  }, { success: 'Playlist created' })

  const connected = !!health?.youtube.connected

  return (
    <div className="h-full overflow-auto">
      <div className="drag h-13 flex items-center px-6 border-b border-border"><h1 className="font-semibold">Playlists</h1></div>
      <div className="grid grid-cols-[320px_minmax(0,1fr)] gap-5 p-6 max-w-6xl">
        <div className="space-y-4">
          <Card title="Your channel" subtitle={`${library.playlists.length} playlist${library.playlists.length === 1 ? '' : 's'}`}
            actions={<IconButton label="Refresh from YouTube" disabled={!connected || refreshing} onClick={() => void call('playlists', () => window.api.refreshPlaylists())}>{refreshing ? <Spinner /> : <RefreshCw size={14} />}</IconButton>}>
            {!connected ? <p className="text-xs text-muted">Connect Google in Settings to load your playlists.</p>
              : library.playlists.length === 0 ? <p className="text-xs text-muted">No playlists yet — create one below or refresh.</p>
              : (
                <ul className="divide-y divide-border/70 -mx-1 max-h-[46vh] overflow-auto">
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
              <Input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="e.g. Taraweeh 1446" disabled={!connected} />
              <div className="flex gap-2">
                <Select value={newPrivacy} onChange={(e) => setNewPrivacy(e.target.value as Privacy)} className="flex-1" disabled={!connected}>
                  <option value="public">Public</option><option value="unlisted">Unlisted</option><option value="private">Private</option>
                </Select>
                <Button variant="primary" onClick={create} disabled={!connected || !newTitle.trim() || useStore.getState().busy['create']}><Plus size={14} /> Create</Button>
              </div>
            </div>
          </Card>
        </div>

        <Card title="Rules" subtitle="Each uploaded video is added to every playlist whose rule matches. Override per recording from the Library."
          actions={<Button size="sm" onClick={add}><Plus size={14} /> Add rule</Button>}>
          {rules.length === 0 ? (
            <Empty icon={<ListMusic size={28} />} title="No rules yet"
              hint={<>Examples: <i>Reciter is AbdullahAlMousa</i> → his playlist · <i>Prayer is Taraweeh</i> → Taraweeh playlist · <i>Surah includes Baqarah</i> → Baqarah playlist · <i>Filename contains Olayan</i> → a keyword playlist.</>}
              action={<Button variant="primary" size="sm" onClick={add}><Plus size={14} /> Add your first rule</Button>} />
          ) : (
            <div className="space-y-2">
              {rules.map((rule) => (
                <div key={rule.id} className="grid grid-cols-[auto_150px_minmax(0,1fr)_minmax(0,1fr)_auto_auto] items-center gap-2 rounded-lg border border-border bg-surface-2/40 p-2">
                  <Switch checked={rule.enabled} onChange={(v) => patch(rule.id, { enabled: v })} label="Enabled" />
                  <Select value={rule.match} onChange={(e) => patch(rule.id, { match: e.target.value as RuleMatch, value: '' })}>
                    {(Object.keys(MATCH_LABEL) as RuleMatch[]).map((m) => <option key={m} value={m}>{MATCH_LABEL[m]}</option>)}
                  </Select>
                  <ValueInput rule={rule} onChange={(value) => patch(rule.id, { value })} reciters={library.reciters.map((r) => r.folder)} />
                  <Select value={rule.playlistId} onChange={(e) => patch(rule.id, { playlistId: e.target.value })}>
                    <option value="">→ choose playlist…</option>
                    {library.playlists.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
                    {rule.playlistId && !library.playlists.some((p) => p.id === rule.playlistId) && <option value={rule.playlistId}>(unknown playlist {rule.playlistId.slice(0, 8)}…)</option>}
                  </Select>
                  <Badge tone={counts.get(rule.id) ? 'info' : 'muted'} className="tabular-nums">{counts.get(rule.id) ?? 0} match{counts.get(rule.id) === 1 ? '' : 'es'}</Badge>
                  <IconButton label="Delete rule" onClick={() => remove(rule.id)}><Trash2 size={14} /></IconButton>
                </div>
              ))}
            </div>
          )}
          <datalist id="surah-keys">{SURAH_KEYS.map((k) => <option key={k} value={k} />)}</datalist>
        </Card>
      </div>
    </div>
  )
}

function ValueInput({ rule, onChange, reciters }: { rule: PlaylistRule; onChange: (v: string) => void; reciters: string[] }) {
  switch (rule.match) {
    case 'reciter':
      return <Select value={rule.value} onChange={(e) => onChange(e.target.value)}><option value="">choose reciter…</option>{reciters.map((r) => <option key={r} value={r}>{r}</option>)}</Select>
    case 'prayer':
      return <Select value={rule.value} onChange={(e) => onChange(e.target.value)}><option value="">choose prayer…</option>{PRAYERS.map((p) => <option key={p} value={p}>{p}</option>)}</Select>
    case 'surah':
      return <Input list="surah-keys" value={rule.value} onChange={(e) => onChange(e.target.value)} placeholder="e.g. baqarah" />
    case 'keyword':
      return <Input value={rule.value} onChange={(e) => onChange(e.target.value)} placeholder="text anywhere in the filename" />
  }
}
