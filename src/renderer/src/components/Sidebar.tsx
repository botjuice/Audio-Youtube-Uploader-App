import { clsx } from 'clsx'
import { useSyncExternalStore } from 'react'
import { Activity, ListMusic, Settings as SettingsIcon, Users, LibraryBig, MonitorPlay, Gauge, Moon, Film, Sun } from 'lucide-react'
import { IconButton } from './ui'
import { useStore, type Page } from '@/store'
import { fmtUntil } from '@/lib/format'
import { ProgressBar } from './ui'
import { UpdateBanner } from './UpdateBanner'

const NAV: { id: Page; label: string; icon: typeof LibraryBig }[] = [
  { id: 'library', label: 'Library', icon: LibraryBig },
  { id: 'playlists', label: 'Playlists', icon: ListMusic },
  { id: 'reciters', label: 'Reciters', icon: Users },
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
]

export function Sidebar() {
  const page = useStore((s) => s.page)
  const setPage = useStore((s) => s.setPage)
  const health = useStore((s) => s.health)
  const isMac = window.platform === 'darwin'
  const attention = useStore((s) => s.library.records.filter((r) => r.status === 'fix' || r.status === 'error').length)
  const saveSettings = useStore((s) => s.saveSettings)
  const isDark = useIsDark()
  const toggleTheme = () => void saveSettings({ theme: isDark ? 'light' : 'dark' })

  return (
    <aside className={clsx('drag flex w-56 shrink-0 flex-col border-r border-border bg-surface/60', isMac ? 'pt-11' : 'pt-3')}>
      <div className="px-4 pb-3 flex items-center gap-2.5">
        <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-indigo-500 to-sky-400 flex items-center justify-center">
          <Film size={14} className="text-white" />
        </div>
        <div className="font-semibold tracking-tight flex-1">Yoosy Joosy</div>
        <IconButton label={isDark ? 'Switch to light mode' : 'Switch to dark mode'} onClick={toggleTheme} className="h-7 w-7">
          {isDark ? <Sun size={15} /> : <Moon size={15} />}
        </IconButton>
      </div>

      <nav className="no-drag px-2 space-y-0.5">
        {NAV.map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => setPage(id)}
            className={clsx('flex w-full items-center gap-2.5 rounded-lg px-2.5 h-8.5 text-[13px] transition-colors',
              page === id ? 'bg-accent/12 text-accent font-medium' : 'text-muted hover:text-text hover:bg-surface-2')}>
            <Icon size={16} />
            <span className="flex-1 text-left">{label}</span>
            {id === 'library' && attention > 0 && (
              <span className="rounded-full bg-warn/15 text-warn text-[10.5px] px-1.5 leading-4 font-semibold">{attention}</span>
            )}
          </button>
        ))}
      </nav>

      <div className="mt-auto no-drag p-3 space-y-2 text-xs">
        <UpdateBanner />
        <HealthRow icon={<MonitorPlay size={13} />} ok={!!health?.youtube.connected}
          label={health?.youtube.connected ? health.youtube.channel ?? 'Connected' : health?.youtube.error ? 'Google: needs attention' : 'Google: not connected'}
          onClick={() => setPage('settings')} />
        <div className="rounded-lg border border-border bg-surface px-2.5 py-2 space-y-1.5">
          <div className="flex items-center justify-between text-muted">
            <span className="inline-flex items-center gap-1.5"><Gauge size={13} /> Today</span>
            <span className="tabular-nums">{health ? `${health.quota.used}/${health.quota.limit}` : '–'}</span>
          </div>
          <ProgressBar value={health ? (health.quota.used / Math.max(1, health.quota.limit)) * 100 : 0}
            tone={health && health.quota.remaining === 0 ? 'warn' : 'accent'} />
          {health && health.quota.remaining === 0 && <div className="text-[11px] text-muted">Resets in {fmtUntil(health.quota.resetsAt)}</div>}
        </div>
        <HealthRow icon={<Moon size={13} />} ok={!!health?.watcher.running} neutral
          label={health?.watcher.busy ? 'Uploading…' : health?.watcher.running ? `Auto-upload on${health.watcher.nextRunAt ? ` · next ${fmtUntil(health.watcher.nextRunAt)}` : ''}` : 'Auto-upload off'}
          onClick={() => setPage('settings')} />
      </div>
    </aside>
  )
}

function HealthRow({ icon, ok, label, onClick, neutral }: { icon: React.ReactNode; ok: boolean; label: string; onClick: () => void; neutral?: boolean }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-2 rounded-lg border border-border bg-surface px-2.5 h-8 text-left hover:bg-surface-2 transition-colors">
      <span className={clsx('h-1.5 w-1.5 rounded-full shrink-0', ok ? 'bg-ok' : neutral ? 'bg-muted/50' : 'bg-err')} />
      <span className="text-muted shrink-0">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  )
}

/** Effective colour scheme (follows nativeTheme set by the main process). One shared MediaQueryList, subscribed via useSyncExternalStore. */
const darkMq = window.matchMedia('(prefers-color-scheme: dark)')
const subscribeDark = (cb: () => void) => { darkMq.addEventListener('change', cb); return () => darkMq.removeEventListener('change', cb) }
function useIsDark(): boolean {
  return useSyncExternalStore(subscribeDark, () => darkMq.matches)
}
