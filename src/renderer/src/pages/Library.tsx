import { clsx } from 'clsx'
import { ArrowUpFromLine, CloudDownload, RefreshCw, Search, Sparkles, X, Filter } from 'lucide-react'
import { Fragment, useMemo, useState } from 'react'
import type { LibraryRecord, RecordStatus } from '@shared/types'
import { Badge, Button, Checkbox, Empty, IconButton, Input, ProgressBar, Select, Spinner } from '@/components/ui'
import { STATUS_META, fmtUntil, isUploadable } from '@/lib/format'
import { useBusy, useStore } from '@/store'
import { RecordDetail } from './RecordDetail'

type StatusFilter = 'all' | 'attention' | RecordStatus

export default function Library() {
  const library = useStore((s) => s.library)
  const health = useStore((s) => s.health)
  const progress = useStore((s) => s.progress)
  const selectedId = useStore((s) => s.selectedId)
  const select = useStore((s) => s.select)
  const call = useStore((s) => s.call)
  const notify = useStore((s) => s.notify)
  const syncing = useBusy('sync')
  const fixing = useBusy('fixAll')

  const [q, setQ] = useState('')
  const [reciter, setReciter] = useState('all')
  const [status, setStatus] = useState<StatusFilter>('all')

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return library.records.filter((r) => {
      if (reciter !== 'all' && r.reciterFolder !== reciter) return false
      if (status === 'attention' ? !(r.status === 'fix' || r.status === 'error') : status !== 'all' && r.status !== status) return false
      if (needle && !(r.fileName.toLowerCase().includes(needle) || (r.title ?? '').toLowerCase().includes(needle))) return false
      return true
    })
  }, [library.records, q, reciter, status])

  const all = library.records
  const uploadable = all.filter(isUploadable)
  const selectedUploadable = uploadable.filter((r) => r.selected)
  const fixable = all.filter((r) => r.status === 'fix').length
  const uploadIds = (selectedUploadable.length ? selectedUploadable : uploadable).map((r) => r.id)
  const visibleUploadable = rows.filter(isUploadable)
  const allVisibleChecked = visibleUploadable.length > 0 && visibleUploadable.every((r) => r.selected)
  const someVisibleChecked = visibleUploadable.some((r) => r.selected)
  const uploading = !!health?.watcher.busy
  const selected = selectedId ? all.find((r) => r.id === selectedId) ?? null : null

  const uploadBlock =
    !health?.youtube.connected ? 'Connect Google in Settings first'
    : health.quota.remaining === 0 ? `Daily limit reached — resets in ${fmtUntil(health.quota.resetsAt)}`
    : uploadIds.length === 0 ? 'Nothing is ready to upload'
    : null

  const counts = {
    ready: uploadable.length,
    attention: all.filter((r) => r.status === 'fix' || r.status === 'error').length,
    uploaded: all.filter((r) => r.status === 'uploaded').length,
  }

  const toggleVisible = () => call('sel', () => window.api.patchRecords(visibleUploadable.map((r) => r.id), { selected: !allVisibleChecked }))
  const startUpload = () => call('upload', () => window.api.startUpload(uploadIds))
  const sync = () => call('sync', async () => {
    const r = await window.api.syncWithYouTube()
    notify('success', `Sync: ${r.matched} newly matched · ${r.alreadyMarked} already marked · ${r.scannedVideos} channel videos checked`)
  })
  const fixAll = () => call('fixAll', async () => {
    const n = await window.api.applyAllFixes()
    notify(n ? 'success' : 'info', n ? `Renamed ${n} file${n === 1 ? '' : 's'}` : 'Nothing to fix')
  })

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* toolbar */}
        <div className="drag flex items-center gap-2 border-b border-border px-4 h-13 shrink-0">
          <div className="relative no-drag w-64">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search filename or title…" className="pl-8 h-8" />
          </div>
          <Select value={reciter} onChange={(e) => setReciter(e.target.value)} className="h-8">
            <option value="all">All reciters</option>
            {library.reciters.map((r) => <option key={r.folder} value={r.folder}>{r.folder}</option>)}
          </Select>
          <Select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} className="h-8">
            <option value="all">All statuses</option>
            <option value="attention">Needs attention ({counts.attention})</option>
            <option value="ready">Ready ({counts.ready})</option>
            <option value="uploaded">Uploaded ({counts.uploaded})</option>
            <option value="skipped">Skipped</option>
          </Select>
          <div className="ml-auto flex items-center gap-1 no-drag">
            <IconButton label="Rescan folder" onClick={() => call('rescan', () => window.api.rescan())}><RefreshCw size={15} /></IconButton>
            <Button size="sm" variant="ghost" onClick={sync} disabled={syncing || !health?.youtube.connected} title="Match recordings against videos already on your channel and mark them uploaded">
              {syncing ? <Spinner /> : <CloudDownload size={14} />} Sync with YouTube
            </Button>
          </div>
        </div>

        {/* progress strip */}
        {progress && (
          <ProgressStrip progress={progress} record={all.find((r) => r.id === progress.recordId)} onCancel={() => void window.api.cancelUpload()} />
        )}

        {/* table */}
        <div className="flex-1 min-h-0 overflow-auto">
          {all.length === 0 ? (
            <Empty icon={<Filter size={32} />} title="No recordings found"
              hint="Put each reciter in their own folder next to the app's library folder, with one photo and the audio files inside." />
          ) : rows.length === 0 ? (
            <Empty title="Nothing matches these filters" action={<Button size="sm" onClick={() => { setQ(''); setReciter('all'); setStatus('all') }}>Clear filters</Button>} />
          ) : (
            <div>
              <div className="sticky top-0 z-10 grid grid-cols-[28px_104px_minmax(0,1.15fr)_minmax(0,1fr)_76px] items-center gap-3 px-3 h-9 bg-bg/90 backdrop-blur border-b border-border text-[11px] uppercase tracking-wide text-muted">
                <Checkbox checked={allVisibleChecked} indeterminate={!allVisibleChecked && someVisibleChecked} onChange={toggleVisible} disabled={visibleUploadable.length === 0} />
                <div>Status</div><div>Recording</div><div className="text-right">YouTube title</div><div className="text-right">Playlists</div>
              </div>
              {rows.map((r, i) => (
                <Fragment key={r.id}>
                  {reciter === 'all' && (i === 0 || rows[i - 1]!.reciterFolder !== r.reciterFolder) && (
                    <div className="px-3 pt-3 pb-1 text-[11px] font-semibold text-muted">{r.reciterFolder}</div>
                  )}
                  <Row r={r} active={selectedId === r.id} onSelect={() => select(r.id)} progress={progress?.recordId === r.id ? progress.percent : null}
                    onCheck={(v) => call('sel', () => window.api.patchRecord(r.id, { selected: v }))} />
                </Fragment>
              ))}
              <div className="h-6" />
            </div>
          )}
        </div>

        {/* action bar */}
        <div className="flex items-center gap-3 border-t border-border px-4 h-13 shrink-0 bg-surface/60">
          <div className="text-xs text-muted">
            {selectedUploadable.length ? <><b className="text-text">{selectedUploadable.length}</b> selected · </> : null}
            <b className="text-text">{counts.ready}</b> ready · {counts.attention} need attention · {counts.uploaded} uploaded
          </div>
          <div className="ml-auto flex items-center gap-2">
            {fixable > 0 && (
              <Button variant="subtle" onClick={fixAll} disabled={fixing}>{fixing ? <Spinner /> : <Sparkles size={14} />} Fix {fixable} filename{fixable === 1 ? '' : 's'}</Button>
            )}
            {uploading ? (
              <Button variant="danger" onClick={() => void window.api.cancelUpload()}><X size={14} /> Stop after this one</Button>
            ) : (
              <Button variant="primary" onClick={startUpload} disabled={!!uploadBlock} title={uploadBlock ?? undefined}>
                <ArrowUpFromLine size={14} />
                {selectedUploadable.length ? `Upload ${selectedUploadable.length} selected` : `Upload all ready (${Math.min(uploadIds.length, health?.quota.remaining ?? 0)})`}
              </Button>
            )}
          </div>
        </div>
      </div>

      {selected && <RecordDetail record={selected} onClose={() => select(null)} />}
    </div>
  )
}

function Row({ r, active, onSelect, onCheck, progress }: { r: LibraryRecord; active: boolean; onSelect: () => void; onCheck: (v: boolean) => void; progress: number | null }) {
  const meta = STATUS_META[r.status]
  const warn = r.status !== 'uploaded' && r.lastError
  return (
    <div onClick={onSelect}
      className={clsx('grid grid-cols-[28px_104px_minmax(0,1.15fr)_minmax(0,1fr)_76px] items-center gap-3 px-3 h-11 border-b border-border/60 cursor-default transition-colors',
        active ? 'bg-accent/8' : 'hover:bg-surface-2/70')}>
      <Checkbox checked={r.selected} onChange={onCheck} disabled={!isUploadable(r)} />
      <div className="flex items-center gap-1"><Badge tone={meta.tone}>{meta.label}</Badge>{warn && <span className="h-1.5 w-1.5 rounded-full bg-warn" title="Last attempt failed" />}</div>
      <div className="min-w-0">
        <div className="truncate font-mono text-[12px]">{r.fileName}</div>
        {progress !== null ? <ProgressBar value={progress} className="mt-1 h-1" /> :
          r.message && <div className="truncate text-[11px] text-muted">{r.message}</div>}
      </div>
      <div className="min-w-0 truncate text-right text-[13px]" dir="rtl">{r.title ?? <span className="text-muted">—</span>}</div>
      <div className="text-right text-xs text-muted tabular-nums">{r.playlists.final.length ? `${r.playlists.final.length} list${r.playlists.final.length === 1 ? '' : 's'}` : '—'}</div>
    </div>
  )
}

function ProgressStrip({ progress, record, onCancel }: { progress: { stage: string; percent: number; detail?: string }; record?: LibraryRecord; onCancel: () => void }) {
  const stage = { encode: 'Rendering video', upload: 'Uploading to YouTube', playlist: 'Adding to playlists' }[progress.stage] ?? progress.stage
  return (
    <div className="border-b border-border bg-accent/6 px-4 py-2.5 flex items-center gap-3">
      <Spinner className="text-accent" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between text-xs">
          <span><b>{stage}</b> <span className="text-muted">· {record?.fileName ?? progress.detail}</span></span>
          <span className="tabular-nums text-muted">{progress.percent}%</span>
        </div>
        <ProgressBar value={progress.percent} className="mt-1.5" />
      </div>
      <Button size="sm" variant="ghost" onClick={onCancel}>Stop</Button>
    </div>
  )
}
