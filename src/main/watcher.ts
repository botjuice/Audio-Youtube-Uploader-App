import chokidar, { type FSWatcher } from 'chokidar'
import { extname } from 'node:path'
import { AUDIO_EXTS, STATE_DIR } from './paths'

export interface WatcherOptions {
  library: string
  /** Minutes between upload runs; null = watch the folder for changes but never upload by itself. */
  intervalMinutes: number | null
  /** Files changed on disk — caller should rescan + notify UI. */
  onChange: () => void
  /** Time to upload whatever is ready. */
  onTick: () => Promise<void>
}

export class Watcher {
  private fsw: FSWatcher | null = null
  private interval: NodeJS.Timeout | null = null
  private changeDebounce: NodeJS.Timeout | null = null
  private newFileDebounce: NodeJS.Timeout | null = null
  private _nextRunAt: Date | null = null
  private opts: WatcherOptions | null = null

  /** Auto-upload timer on. */
  get running(): boolean { return this.interval !== null }
  /** Folder changes are being picked up (always, while a library is open). */
  get watching(): boolean { return this.fsw !== null }
  get nextRunAt(): Date | null { return this._nextRunAt }

  start(opts: WatcherOptions): void {
    this.stop()
    this.opts = opts
    if (opts.intervalMinutes !== null) {
      const ms = Math.max(1, opts.intervalMinutes) * 60_000
      const schedule = () => { this._nextRunAt = new Date(Date.now() + ms) }
      this.interval = setInterval(() => { schedule(); void opts.onTick() }, ms)
      schedule()
    }

    this.fsw = chokidar.watch(opts.library, {
      depth: 1, ignoreInitial: true, persistent: true,
      ignored: (p) => p.includes(`/${STATE_DIR}`) || p.includes(`\\${STATE_DIR}`) || /(^|[\\/])\../.test(p.slice(opts.library.length)),
      awaitWriteFinish: { stabilityThreshold: 4000, pollInterval: 500 },
    })
    const changed = () => {
      if (this.changeDebounce) clearTimeout(this.changeDebounce)
      this.changeDebounce = setTimeout(() => opts.onChange(), 1200)
    }
    this.fsw.on('add', (p) => {
      changed()
      if (this.interval && AUDIO_EXTS.has(extname(p).toLowerCase())) {
        // New audio landed — give the user a moment, then upload without waiting for the full interval.
        if (this.newFileDebounce) clearTimeout(this.newFileDebounce)
        this.newFileDebounce = setTimeout(() => void opts.onTick(), 20_000)
      }
    })
    this.fsw.on('unlink', changed).on('change', changed).on('addDir', changed).on('unlinkDir', changed)
    this.fsw.on('error', () => {})
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval)
    if (this.changeDebounce) clearTimeout(this.changeDebounce)
    if (this.newFileDebounce) clearTimeout(this.newFileDebounce)
    this.interval = this.changeDebounce = this.newFileDebounce = null
    this._nextRunAt = null
    void this.fsw?.close()
    this.fsw = null
    this.opts = null
  }

  /** Restart with the same callbacks but a new interval (settings change). */
  reconfigure(intervalMinutes: number | null): void {
    if (this.opts) this.start({ ...this.opts, intervalMinutes })
  }
}
