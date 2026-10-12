import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

/** Atomic write: temp file + rename, so a crash never leaves a half-written JSON. */
export async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
  await fs.rename(tmp, file)
}

export class JsonFile<T extends object> {
  private data: T
  private loaded = false
  private saving: Promise<void> = Promise.resolve()
  constructor(private readonly file: string, private readonly defaults: () => T) {
    this.data = defaults()
  }
  async load(): Promise<T> {
    this.data = { ...this.defaults(), ...(await readJson<Partial<T>>(this.file, {})) } as T
    this.loaded = true
    return this.data
  }
  get(): T {
    if (!this.loaded) throw new Error(`JsonFile not loaded: ${this.file}`)
    return this.data
  }
  async update(mutate: (d: T) => void): Promise<T> {
    mutate(this.get())
    await this.save()
    return this.data
  }
  async replace(next: T): Promise<T> {
    this.data = next
    await this.save()
    return this.data
  }
  save(): Promise<void> {
    // serialise writes
    this.saving = this.saving.then(() => writeJson(this.file, this.data))
    return this.saving
  }
}
