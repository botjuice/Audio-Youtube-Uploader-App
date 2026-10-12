import { promises as fs } from 'node:fs'
import { EventEmitter } from 'node:events'
import type { ActivityEntry } from '@shared/types'
import { stateFile } from './paths'

class Activity extends EventEmitter {
  private buffer: ActivityEntry[] = []
  private file: string | null = null
  private readonly max = 500

  setLibrary(library: string | null) {
    this.file = library ? stateFile(library, 'activity.log') : null
  }
  entries(): ActivityEntry[] { return this.buffer }

  private push(level: ActivityEntry['level'], message: string, recordId?: string) {
    const e: ActivityEntry = { at: new Date().toISOString(), level, message, ...(recordId ? { recordId } : {}) }
    this.buffer.push(e)
    if (this.buffer.length > this.max) this.buffer.splice(0, this.buffer.length - this.max)
    this.emit('entry', e)
    if (this.file) {
      fs.appendFile(this.file, `${e.at} [${level}] ${recordId ? `(${recordId}) ` : ''}${message}\n`).catch(() => {})
    }
  }
  info(msg: string, id?: string) { this.push('info', msg, id) }
  warn(msg: string, id?: string) { this.push('warn', msg, id) }
  error(msg: string, id?: string) { this.push('error', msg, id) }
  success(msg: string, id?: string) { this.push('success', msg, id) }
}

export const activity = new Activity()
