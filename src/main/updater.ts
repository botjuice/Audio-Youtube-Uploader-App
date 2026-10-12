import { app } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createWriteStream, promises as fs } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { UpdateState } from '@shared/types'
import { compareVersions, feedFileName, parseLatestYml, pickUpdateFile } from '@core/update'
import { activity } from './log'

const execFileP = promisify(execFile)

export const REPO = 'botjuice/Audio-Youtube-Uploader-App'
const FEED_BASE = `https://github.com/${REPO}/releases/latest/download/`
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`
const CHECK_EVERY_MS = 6 * 60 * 60_000
const FIRST_CHECK_MS = 30_000

export interface UpdaterDeps {
  /** True while an upload run is in progress — we never install then. */
  isBusy(): boolean
  /** True when the user can see the window — we never restart under them. */
  isWindowVisible(): boolean
  autoCheck(): boolean
  autoInstall(): boolean
  /** Called right before install: stop the watcher so it can't start a run. */
  prepareForRestart(): Promise<void>
}

export class Updater extends EventEmitter {
  state: UpdateState = {
    status: 'idle', current: app.getVersion(), latest: null, notes: null, releaseUrl: null,
    percent: 0, error: null, deferred: null, checkedAt: null,
  }
  private deps!: UpdaterDeps
  private file: string | null = null
  private sha512: string | null = null
  private timer: NodeJS.Timeout | null = null
  private inflight: Promise<unknown> | null = null
  /** Set once install begins; the watcher checks it so no new run starts. */
  installing = false

  start(deps: UpdaterDeps): void {
    this.deps = deps
    if (!app.isPackaged) { this.set({ status: 'up-to-date', deferred: 'Updates are disabled in development builds' }); return }
    setTimeout(() => void this.autoCycle(), FIRST_CHECK_MS)
    this.timer = setInterval(() => void this.autoCycle(), CHECK_EVERY_MS)
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch }
    this.emit('state', this.state)
  }

  private async autoCycle(): Promise<void> {
    if (!this.deps.autoCheck()) return
    try {
      await this.check()
      if (this.state.status === 'available') await this.download()
      this.maybeAutoInstall()
    } catch { /* state already carries the error */ }
  }

  /** Query the release feed. Resolves to the new state; never throws to callers on network errors. */
  async check(): Promise<UpdateState> {
    if (this.inflight) { await this.inflight.catch(() => {}); return this.state }
    const p = (async () => {
      this.set({ status: 'checking', error: null })
      try {
        const res = await fetch(FEED_BASE + feedFileName(process.platform), { headers: { 'Cache-Control': 'no-cache' }, redirect: 'follow' })
        if (!res.ok) throw new Error(`Update feed returned ${res.status}`)
        const info = parseLatestYml(await res.text())
        const checkedAt = new Date().toISOString()
        if (compareVersions(info.version, this.state.current) <= 0) {
          this.set({ status: this.file ? 'ready' : 'up-to-date', latest: info.version, checkedAt })
          return
        }
        const file = pickUpdateFile(info, process.platform, process.arch)
        if (!file) throw new Error(`No installer for ${process.platform}/${process.arch} in release ${info.version}`)
        this.sha512 = file.sha512
        // Already downloaded this exact version?
        if (this.file && this.state.latest === info.version && (await fs.access(this.file).then(() => true, () => false))) {
          this.set({ status: 'ready', latest: info.version, checkedAt }); return
        }
        this.file = null
        let notes: string | null = null, releaseUrl: string | null = `https://github.com/${REPO}/releases/latest`
        try {
          const r = await fetch(API_LATEST, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'yoosy-joosy' } })
          if (r.ok) { const j = (await r.json()) as { body?: string; html_url?: string }; notes = j.body?.trim() || null; releaseUrl = j.html_url ?? releaseUrl }
        } catch { /* notes are optional */ }
        this.pendingUrl = FEED_BASE + file.url
        this.set({ status: 'available', latest: info.version, notes, releaseUrl, checkedAt, percent: 0 })
        activity.info(`Update available: v${info.version} (you have v${this.state.current})`)
      } catch (e) {
        this.set({ status: 'error', error: e instanceof Error ? e.message : String(e), checkedAt: new Date().toISOString() })
      }
    })()
    this.inflight = p
    try { await p } finally { this.inflight = null }
    return this.state
  }
  private pendingUrl: string | null = null

  async download(): Promise<UpdateState> {
    if (this.state.status === 'ready' && this.file) return this.state
    if (this.state.status !== 'available' || !this.pendingUrl || !this.sha512) return this.state
    if (this.inflight) { await this.inflight.catch(() => {}); return this.state }
    const p = (async () => {
      const dir = join(app.getPath('userData'), 'updates')
      await fs.mkdir(dir, { recursive: true })
      for (const f of await fs.readdir(dir)) await fs.rm(join(dir, f), { recursive: true, force: true }) // only ever keep one
      const target = join(dir, basename(new URL(this.pendingUrl!).pathname))
      const tmp = `${target}.part`
      this.set({ status: 'downloading', percent: 0, error: null })
      try {
        const res = await fetch(this.pendingUrl!, { redirect: 'follow' })
        if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status}`)
        const total = Number(res.headers.get('content-length') ?? 0)
        const hash = createHash('sha512')
        const out = createWriteStream(tmp)
        let got = 0, lastPct = -1
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          hash.update(chunk); got += chunk.length
          if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()))
          const pct = total ? Math.floor((got / total) * 100) : 0
          if (pct !== lastPct) { lastPct = pct; this.set({ percent: pct }) }
        }
        await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())))
        const digest = hash.digest('base64')
        if (digest !== this.sha512) throw new Error('Downloaded file failed integrity check (sha512 mismatch)')
        await fs.rename(tmp, target)
        this.file = target
        this.set({ status: 'ready', percent: 100 })
        activity.success(`Update v${this.state.latest} downloaded — will install when idle`)
      } catch (e) {
        await fs.rm(tmp, { force: true })
        this.set({ status: 'error', error: e instanceof Error ? e.message : String(e) })
      }
    })()
    this.inflight = p
    try { await p } finally { this.inflight = null }
    return this.state
  }

  /** Install automatically only when it cannot possibly disturb anyone. Call on pipeline-done and window-hide. */
  maybeAutoInstall(): void {
    if (this.state.status !== 'ready' || this.installing) return
    if (this.deps.isBusy()) { this.set({ deferred: 'Will install after the current upload finishes' }); return }
    if (this.deps.isWindowVisible()) { this.set({ deferred: 'Ready — restart when convenient' }); return }
    if (!this.deps.autoInstall()) { this.set({ deferred: 'Automatic install is off — restart from Settings' }); return }
    void this.install()
  }

  /** Apply the downloaded update and relaunch. Refuses while an upload is running. */
  async install(): Promise<void> {
    if (this.state.status !== 'ready' || !this.file) throw new Error('No update is downloaded yet')
    if (this.deps.isBusy()) throw new Error('An upload is in progress — the update will apply when it finishes')
    if (this.installing) return
    this.installing = true
    this.set({ status: 'installing', deferred: null })
    activity.info(`Installing update v${this.state.latest} and restarting…`)
    try {
      await this.deps.prepareForRestart()
      if (process.platform === 'win32') await this.installWindows(this.file)
      else if (process.platform === 'darwin') await this.installMac(this.file)
      else throw new Error('Automatic install is not supported on this platform — download from the releases page')
    } catch (e) {
      this.installing = false
      const msg = e instanceof Error ? e.message : String(e)
      activity.error(`Update failed: ${msg}`)
      this.set({ status: 'error', error: msg })
      throw e
    }
  }

  private async installWindows(installer: string): Promise<void> {
    // electron-builder NSIS: silent reinstall over the existing directory, then start the app.
    const child = spawn(installer, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    setTimeout(() => app.quit(), 500)
  }

  private async installMac(zip: string): Promise<void> {
    const bundle = resolve(app.getPath('exe'), '..', '..', '..')         // …/Yoosy Joosy.app
    if (!bundle.endsWith('.app')) throw new Error(`Unexpected app location: ${bundle}`)
    const tmp = await fs.mkdtemp(join(app.getPath('temp'), 'yj-update-'))
    await execFileP('ditto', ['-x', '-k', zip, tmp])
    const extracted = (await fs.readdir(tmp)).find((n) => n.endsWith('.app'))
    if (!extracted) throw new Error('Downloaded archive did not contain an app bundle')
    const fresh = join(tmp, extracted)
    const old = `${bundle}.old`
    await fs.rm(old, { recursive: true, force: true })
    try {
      await fs.rename(bundle, old)                       // the running process keeps its open files; safe
    } catch (e) {
      throw new Error(`Cannot replace the app at ${bundle} (${(e as NodeJS.ErrnoException).code}). Move it to your home Applications folder, or install the new version manually.`)
    }
    try {
      await execFileP('ditto', [fresh, bundle])          // copy preserves symlinks, permissions, xattrs
    } catch (e) {
      await fs.rename(old, bundle).catch(() => {})       // roll back
      throw e
    }
    await execFileP('xattr', ['-dr', 'com.apple.quarantine', bundle]).catch(() => {})
    await fs.rm(old, { recursive: true, force: true }).catch(() => {})
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
    app.relaunch()
    setTimeout(() => app.exit(0), 300)
  }
}

export const updater = new Updater()
