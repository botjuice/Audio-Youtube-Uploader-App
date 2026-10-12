import { CheckCircle2, ExternalLink, FolderOpen, KeyRound, LogOut, Plus, RefreshCw, Search, Trash2, Unplug } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Privacy, ThemeMode } from '@shared/types'
import type { SurahEntry } from '@shared/api'
import { Badge, Button, Card, Field, Input, Select, Spinner, Switch, Textarea } from '@/components/ui'
import { useBusy, useStore } from '@/store'

const LINKS = {
  project: 'https://console.cloud.google.com/projectcreate',
  api: 'https://console.cloud.google.com/apis/library/youtube.googleapis.com',
  consent: 'https://console.cloud.google.com/auth/overview',
  creds: 'https://console.cloud.google.com/apis/credentials',
}

export default function Settings() {
  const settings = useStore((s) => s.settings)!
  const health = useStore((s) => s.health)
  const save = useStore((s) => s.saveSettings)
  const call = useStore((s) => s.call)
  const connecting = useBusy('connect')
  const [pasteOpen, setPasteOpen] = useState(false)
  const [cid, setCid] = useState(''); const [csec, setCsec] = useState('')
  const [tags, setTags] = useState(settings.upload.tags.join(', '))
  const [desc, setDesc] = useState(settings.upload.description)

  const yt = health?.youtube
  const connect = () => call('connect', async () => { await window.api.connectYouTube() }, { success: 'Connected to YouTube' })

  return (
    <div className="h-full overflow-auto">
      <div className="drag h-13 flex items-center px-6 border-b border-border"><h1 className="font-semibold">Settings</h1></div>
      <div className="p-6 max-w-3xl space-y-5">

        <Card title="Google / YouTube" subtitle={yt?.connected ? <span className="inline-flex items-center gap-1 text-ok"><CheckCircle2 size={13} /> Connected as <b>{yt.channel}</b></span> : yt?.error ? <span className="text-err">{yt.error}</span> : 'Not connected'}
          actions={yt?.connected
            ? <Button size="sm" onClick={() => void call('disconnect', () => window.api.disconnectYouTube(), { success: 'Disconnected' })}><LogOut size={13} /> Disconnect</Button>
            : <Button size="sm" variant="primary" onClick={connect} disabled={!yt?.hasClientSecret || connecting}>{connecting ? <Spinner /> : <Unplug size={13} />} {yt?.error ? 'Reconnect' : 'Connect Google'}</Button>}>
          <div className="space-y-3 text-[12.5px]">
            <div className="flex items-center gap-2">
              <Badge tone={yt?.hasClientSecret ? 'ok' : 'warn'}><KeyRound size={11} /> {yt?.hasClientSecret ? 'OAuth client saved' : 'OAuth client missing'}</Badge>
              <Button size="sm" onClick={() => void call('secret', async () => { if (await window.api.setClientSecretFromFile()) useStore.getState().notify('success', 'OAuth client saved') })}>Choose client_secret.json…</Button>
              <Button size="sm" variant="ghost" onClick={() => setPasteOpen((v) => !v)}>Paste ID & secret</Button>
            </div>
            {pasteOpen && (
              <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
                <Input value={cid} onChange={(e) => setCid(e.target.value)} placeholder="Client ID (…apps.googleusercontent.com)" className="font-mono text-xs" />
                <Input value={csec} onChange={(e) => setCsec(e.target.value)} placeholder="Client secret" className="font-mono text-xs" type="password" />
                <Button size="sm" variant="primary" onClick={() => void call('secret', () => window.api.setClientSecret(cid, csec).then(() => { setPasteOpen(false); setCid(''); setCsec('') }), { success: 'OAuth client saved' })}>Save</Button>
              </div>
            )}
            <details className="rounded-lg border border-border bg-surface-2/40 p-3">
              <summary className="cursor-pointer font-medium">How to get an OAuth client (one-time, ~5 minutes)</summary>
              <ol className="mt-2 space-y-2 list-decimal pl-5 text-muted">
                <li><Lnk href={LINKS.project}>Create a Google Cloud project</Lnk> — any name, e.g. “YouTube Quran Uploader”.</li>
                <li><Lnk href={LINKS.api}>Enable the YouTube Data API v3</Lnk> in that project.</li>
                <li><Lnk href={LINKS.consent}>Set up the OAuth consent screen</Lnk>: audience <b>External</b>, add your own Gmail as a test user.
                  <div className="mt-1 rounded bg-warn/10 text-warn px-2 py-1">Important: while the app is in <b>Testing</b>, Google expires your sign-in every 7 days. Click <b>Publish app</b> on that page once — you don't need verification for personal use; the sign-in screen will just show an “unverified app” warning you click through once.</div></li>
                <li><Lnk href={LINKS.creds}>Create credentials → OAuth client ID</Lnk> → application type <b>Desktop app</b> → Download JSON.</li>
                <li>Click <b>Choose client_secret.json…</b> above, then <b>Connect Google</b>. Pick the account that owns your YouTube channel.</li>
              </ol>
            </details>
          </div>
        </Card>

        <Card title="Library folder" subtitle="The folder that contains one sub-folder per reciter"
          actions={<Button size="sm" onClick={() => void call('lib', () => window.api.chooseLibrary())}><FolderOpen size={13} /> Change…</Button>}>
          <code className="text-xs break-all">{settings.libraryPath ?? '— not set —'}</code>
          {health && <div className="text-xs text-muted mt-1">{health.library.reciters} reciter{health.library.reciters === 1 ? '' : 's'} · {health.library.records} recording{health.library.records === 1 ? '' : 's'}</div>}
        </Card>

        <Card title="Appearance">
          <div className="inline-flex rounded-lg border border-border bg-surface-2/40 p-0.5">
            {(['system', 'light', 'dark'] as ThemeMode[]).map((m) => (
              <button key={m} onClick={() => void save({ theme: m })}
                className={`h-8 px-4 rounded-md text-[13px] capitalize transition-colors ${settings.theme === m ? 'bg-surface shadow-xs font-medium' : 'text-muted hover:text-text'}`}>
                {m === 'system' ? 'Match system' : m}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted mt-2">The sun/moon button in the sidebar switches between light and dark instantly.</p>
        </Card>

        <Card title="Automatic uploads" subtitle="Watch the library for new recordings and upload them without opening the app">
          <div className="space-y-3">
            <Field inline label="Auto-upload new files" hint="Polls on a schedule and reacts to files being dropped in">
              <Switch checked={settings.watcher.enabled} onChange={(v) => void save({ watcher: { ...settings.watcher, enabled: v } })} />
            </Field>
            <Field inline label="Check every" hint="minutes between scheduled checks">
              <Input type="number" min={1} max={1440} value={settings.watcher.intervalMinutes} className="w-24"
                onChange={(e) => void save({ watcher: { ...settings.watcher, intervalMinutes: Math.max(1, Number(e.target.value) || 30) } })} />
            </Field>
            <Field inline label="Start when I log in" hint="Launches hidden in the tray / menu bar">
              <Switch checked={settings.watcher.startOnLogin} onChange={(v) => void save({ watcher: { ...settings.watcher, startOnLogin: v } })} />
            </Field>
            <Field inline label="Keep running when the window is closed" hint="Only while auto-upload is on; use Quit from the tray icon to exit">
              <Switch checked={settings.watcher.closeToTray} onChange={(v) => void save({ watcher: { ...settings.watcher, closeToTray: v } })} />
            </Field>
          </div>
        </Card>

        <Card title="Upload defaults" subtitle="Applied to every video">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Uploads per day" hint="YouTube's default API quota allows about 6">
              <Input type="number" min={1} max={200} value={settings.upload.dailyLimit} onChange={(e) => void save({ upload: { ...settings.upload, dailyLimit: Math.max(1, Number(e.target.value) || 6) } })} />
            </Field>
            <Field label="Visibility">
              <Select value={settings.upload.privacy} onChange={(e) => void save({ upload: { ...settings.upload, privacy: e.target.value as Privacy } })} className="w-full">
                <option value="public">Public</option><option value="unlisted">Unlisted</option><option value="private">Private</option>
              </Select>
            </Field>
            <Field label="Category ID" hint="22 People & Blogs · 27 Education · 29 Nonprofits">
              <Input value={settings.upload.categoryId} onChange={(e) => void save({ upload: { ...settings.upload, categoryId: e.target.value || '22' } })} />
            </Field>
            <Field inline label="Made for kids">
              <Switch checked={settings.upload.madeForKids} onChange={(v) => void save({ upload: { ...settings.upload, madeForKids: v } })} />
            </Field>
            <Field label="Tags" hint="Comma-separated">
              <Input value={tags} onChange={(e) => setTags(e.target.value)} onBlur={() => void save({ upload: { ...settings.upload, tags: tags.split(',').map((t) => t.trim()).filter(Boolean) } })} />
            </Field>
            <div className="col-span-2">
              <Field label="Description">
                <Textarea value={desc} onChange={(e) => setDesc(e.target.value)} onBlur={() => void save({ upload: { ...settings.upload, description: desc } })} placeholder="Shown under every video" />
              </Field>
            </div>
          </div>
        </Card>

        <SurahEditor />
        <UpdatesCard />
      </div>
    </div>
  )
}

function Lnk({ href, children }: { href: string; children: React.ReactNode }) {
  return <button className="text-accent hover:underline inline-flex items-center gap-1" onClick={() => void window.api.openExternal(href)}>{children}<ExternalLink size={11} /></button>
}

function SurahEditor() {
  const call = useStore((s) => s.call)
  const [all, setAll] = useState<SurahEntry[]>([])
  const [q, setQ] = useState('')
  const [key, setKey] = useState(''); const [ar, setAr] = useState('')
  const load = () => void window.api.listSurahs().then(setAll)
  useEffect(load, [])
  const needle = q.trim().toLowerCase()
  const shown = needle ? all.filter((s) => s.key.includes(needle) || s.arabic.includes(q.trim())).slice(0, 60) : []

  return (
    <Card title="Surah spellings" subtitle={`${all.length} spellings known. Add one when a filename uses a spelling the app doesn't recognise.`}>
      <div className="grid grid-cols-[1fr_1fr_auto] gap-2 mb-3">
        <Input value={key} onChange={(e) => setKey(e.target.value)} placeholder="Spelling in filenames, e.g. Thashr" />
        <Input dir="rtl" value={ar} onChange={(e) => setAr(e.target.value)} placeholder="الحشر" />
        <Button variant="primary" disabled={!key.trim() || !ar.trim()} onClick={() => void call('surah', () => window.api.setSurah(key, ar).then(() => { setKey(''); setAr(''); load() }), { success: 'Spelling added' })}><Plus size={14} /> Add</Button>
      </div>
      <div className="relative">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search existing spellings (type 2+ letters)…" className="pl-8" />
      </div>
      {needle.length >= 2 && (
        <ul className="mt-2 divide-y divide-border/70 max-h-72 overflow-auto rounded-lg border border-border">
          {shown.length === 0 && <li className="p-3 text-xs text-muted">No matches</li>}
          {shown.map((s) => <SurahRow key={s.key} s={s} onChanged={load} />)}
        </ul>
      )}
    </Card>
  )
}

function SurahRow({ s, onChanged }: { s: SurahEntry; onChanged: () => void }) {
  const call = useStore((s) => s.call)
  const [ar, setAr] = useState(s.arabic)
  return (
    <li className="flex items-center gap-2 px-2 py-1.5 text-xs">
      <code className="w-36 truncate">{s.key}</code>
      <Input dir="rtl" value={ar} onChange={(e) => setAr(e.target.value)} className="h-7 flex-1" onBlur={() => ar.trim() && ar !== s.arabic && void call('surah', () => window.api.setSurah(s.key, ar).then(onChanged))} />
      {s.source === 'user' && <Badge tone="info">custom</Badge>}
      <Button size="sm" variant="ghost" onClick={() => void call('surah', () => window.api.deleteSurah(s.key).then(onChanged))} title="Delete"><Trash2 size={13} /></Button>
    </li>
  )
}

function UpdatesCard() {
  const settings = useStore((s) => s.settings)!
  const health = useStore((s) => s.health)
  const u = useStore((s) => s.update)
  const save = useStore((s) => s.saveSettings)
  const call = useStore((s) => s.call)
  const checking = useBusy('chk') || u?.status === 'checking'
  const status =
    !u ? '' :
    u.status === 'up-to-date' ? `Up to date${u.checkedAt ? ` · checked ${new Date(u.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}${u.deferred ? ` · ${u.deferred}` : ''}` :
    u.status === 'available' ? `v${u.latest} available` :
    u.status === 'downloading' ? `Downloading v${u.latest}… ${u.percent}%` :
    u.status === 'ready' ? `v${u.latest} downloaded — ${u.deferred ?? 'restart to apply'}` :
    u.status === 'installing' ? 'Installing…' :
    u.status === 'error' ? `Problem: ${u.error}` : 'Checking…'
  return (
    <Card title={`About · YouTube Quran Uploader v${health?.app.version ?? '…'}`} subtitle={status}
      actions={<Button size="sm" disabled={checking} onClick={() => void call('chk', async () => { const r = await window.api.checkForUpdates(); if (r.status === 'up-to-date') useStore.getState().notify('success', 'You have the latest version') })}>{checking ? <Spinner /> : <RefreshCw size={13} />} Check now</Button>}>
      <div className="space-y-3">
        <Field inline label="Check for updates automatically" hint="On launch and every 6 hours. Downloads happen in the background.">
          <Switch checked={settings.updates.autoCheck} onChange={(v) => void save({ updates: { ...settings.updates, autoCheck: v } })} />
        </Field>
        <Field inline label="Install when idle" hint="Only while the window is hidden and nothing is uploading — an upload in progress is never interrupted. With the window open you'll always be asked first.">
          <Switch checked={settings.updates.autoInstallWhenIdle} onChange={(v) => void save({ updates: { ...settings.updates, autoInstallWhenIdle: v } })} />
        </Field>
        <div className="text-xs text-muted">
          Releases: <Lnk href="https://github.com/botjuice/Audio-Youtube-Uploader-App/releases">github.com/botjuice/Audio-Youtube-Uploader-App</Lnk>
        </div>
      </div>
    </Card>
  )
}
