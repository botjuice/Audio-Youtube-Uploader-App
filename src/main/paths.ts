import { app } from 'electron'
import { join } from 'node:path'

export const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.wav', '.aac', '.ogg', '.flac', '.opus', '.wma'])
export const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp'])
export const STATE_DIR = '.yoosyjoosy'

export const userData = () => app.getPath('userData')
export const settingsFile = () => join(userData(), 'settings.json')
export const secretFile = () => join(userData(), 'google-client.bin')
export const tokenFile = () => join(userData(), 'google-token.bin')

export const stateDir = (library: string) => join(library, STATE_DIR)
export const stateFile = (library: string, name: string) => join(stateDir(library), name)
