import { app, BrowserWindow, Menu, Tray, nativeImage, nativeTheme, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { yoosy } from './app'
import { registerIpc } from './ipc'
import { activity } from './log'

const here = fileURLToPath(new URL('.', import.meta.url))
const isMac = process.platform === 'darwin'
let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false

if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => { showWindow() })

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1240, height: 800, minWidth: 980, minHeight: 640,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0f17' : '#f6f7fb',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 16 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
    },
  })
  w.once('ready-to-show', () => w.show())
  w.on('close', (e) => {
    if (quitting) return
    const s = yoosy.settings
    if (s.watcher.enabled && s.watcher.closeToTray) { e.preventDefault(); w.hide(); return }
    if (isMac) { e.preventDefault(); w.hide() }
  })
  w.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: 'deny' } })
  if (process.env['ELECTRON_RENDERER_URL']) void w.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else void w.loadFile(join(here, '../renderer/index.html'))
  return w
}

function showWindow(): void {
  if (!win || win.isDestroyed()) win = createWindow()
  if (win.isMinimized()) win.restore()
  win.show(); win.focus()
}

function buildTray(): void {
  const icon = nativeImage.createFromPath(join(here, '../../resources', isMac ? 'trayTemplate.png' : 'tray.png'))
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('Yoosy Joosy')
  const refresh = () => {
    const w = yoosy.settings.watcher
    tray?.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Yoosy Joosy', click: showWindow },
      { type: 'separator' },
      { label: 'Auto-upload new files', type: 'checkbox', checked: w.enabled,
        click: (item) => void yoosy.setSettings({ watcher: { ...yoosy.settings.watcher, enabled: item.checked } }) },
      { label: 'Upload ready now', click: () => {
        const ids = yoosy.snapshot.records.filter((r) => (r.status === 'ready' || r.status === 'encoded') && !r.skipped).map((r) => r.id)
        void yoosy.startUpload(ids)
      } },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit() } },
    ]))
  }
  refresh()
  tray.on('click', showWindow)
  yoosy.onBroadcast((ch) => { if (ch === 'evt:health') refresh() })
}

void app.whenReady().then(async () => {
  if (isMac) app.dock?.setIcon(nativeImage.createFromPath(join(here, '../../resources/icon.png')))
  await yoosy.init()
  registerIpc()
  buildTray()
  win = createWindow()
  if (process.argv.includes('--hidden')) win.hide()
  activity.info(`Yoosy Joosy ${app.getVersion()} started`)
})

app.on('activate', showWindow)
app.on('before-quit', () => { quitting = true })
app.on('window-all-closed', () => { if (!isMac && !yoosy.settings.watcher.enabled) app.quit() })
