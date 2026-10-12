import { BrowserWindow, ipcMain } from 'electron'
import type { Api } from '@shared/api'
import { activity } from './log'
import { yoosy } from './app'
import { updater } from './updater'

type Handlers = { [K in Exclude<keyof Api, 'on'>]: (win: BrowserWindow | null, ...args: Parameters<Api[K]>) => ReturnType<Api[K]> }

export function registerIpc(): void {
  const h: Handlers = {
    getSettings: async () => yoosy.settings,
    setSettings: (_w, patch) => yoosy.setSettings(patch),
    chooseLibrary: (w) => yoosy.chooseLibrary(w),
    getLibrary: async () => yoosy.getLibrary(),
    rescan: () => yoosy.rescan(),
    patchRecord: (_w, id, patch) => yoosy.patchRecords([id], patch),
    patchRecords: (_w, ids, patch) => yoosy.patchRecords(ids, patch),
    renameRecord: (_w, id, name) => yoosy.renameRecord(id, name),
    applyFix: (_w, id) => yoosy.applyFix(id),
    applyAllFixes: () => yoosy.applyAllFixes(),
    markUploaded: (_w, id, vid) => yoosy.markUploaded(id, vid),
    markNotUploaded: (_w, id) => yoosy.markNotUploaded(id),
    patchReciter: (_w, folder, patch) => yoosy.patchReciter(folder, patch),
    listSurahs: async () => yoosy.listSurahs(),
    setSurah: (_w, k, a) => yoosy.setSurah(k, a),
    deleteSurah: (_w, k) => yoosy.deleteSurah(k),
    setRules: (_w, rules) => yoosy.setRules(rules),
    setClientSecretFromFile: (w) => yoosy.setClientSecretFromFile(w),
    setClientSecret: (_w, id, s) => yoosy.setClientSecret(id, s),
    connectYouTube: () => yoosy.connectYouTube(),
    disconnectYouTube: () => yoosy.disconnectYouTube(),
    refreshPlaylists: () => yoosy.refreshPlaylists(),
    createPlaylist: (_w, t, p) => yoosy.createPlaylist(t, p),
    syncWithYouTube: () => yoosy.syncWithYouTube(),
    startUpload: (_w, ids) => yoosy.startUpload(ids),
    cancelUpload: async () => yoosy.cancelUpload(),
    getUpdateState: async () => updater.state,
    checkForUpdates: () => updater.check(),
    downloadUpdate: () => updater.download(),
    installUpdate: () => updater.install(),
    getHealth: () => yoosy.getHealth(),
    getActivity: async () => activity.entries(),
    openExternal: (_w, url) => yoosy.openExternal(url),
    showInFolder: async (_w, p) => yoosy.showInFolder(p),
  }
  for (const [name, fn] of Object.entries(h)) {
    ipcMain.handle(name, (e, ...args) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      return (fn as (w: BrowserWindow | null, ...a: unknown[]) => unknown)(win, ...args)
    })
  }
  yoosy.onBroadcast((channel, payload) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload)
  })
}
