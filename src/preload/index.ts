import { contextBridge, ipcRenderer } from 'electron'

const methods = [
  'getSettings', 'setSettings', 'chooseLibrary', 'getLibrary', 'rescan', 'patchRecord', 'patchRecords',
  'renameRecord', 'applyFix', 'applyAllFixes', 'markUploaded', 'markNotUploaded', 'patchReciter', 'addReciter', 'validateToken',
  'listSurahs', 'setSurah', 'deleteSurah', 'setRules', 'setKeywords', 'setThumbnailRules',
  'setClientSecretFromFile', 'setClientSecret', 'connectYouTube', 'disconnectYouTube',
  'refreshPlaylists', 'createPlaylist', 'syncWithYouTube', 'previewThumbnail', 'previewReciterThumbnail', 'retryThumbnail', 'renderStyled', 'getStyleSchema', 'listSurahOptions', 'startUpload', 'cancelUpload',
  'getUpdateState', 'checkForUpdates', 'downloadUpdate', 'installUpdate',
  'getHealth', 'getActivity', 'openExternal', 'showInFolder',
] as const

const api: Record<string, unknown> = {}
for (const m of methods) api[m] = (...args: unknown[]) => ipcRenderer.invoke(m, ...args)
api['on'] = (event: string, cb: (payload: unknown) => void) => {
  const channel = `evt:${event}`
  const listener = (_e: Electron.IpcRendererEvent, payload: unknown) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}
contextBridge.exposeInMainWorld('api', api)
contextBridge.exposeInMainWorld('platform', process.platform)
