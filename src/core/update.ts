import { parse } from 'yaml'

/** Numeric semver compare on x.y.z (prerelease/build metadata ignored). >0 if a is newer. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split(/[-+]/)[0]!.split('.').map(Number)
  const pb = b.replace(/^v/, '').split(/[-+]/)[0]!.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

export interface UpdateFile { url: string; sha512: string; size: number }
export interface LatestInfo { version: string; files: UpdateFile[]; releaseDate?: string }

/** Parse electron-builder's latest.yml / latest-mac.yml. */
export function parseLatestYml(text: string): LatestInfo {
  const y = parse(text) as { version?: string; files?: UpdateFile[]; path?: string; sha512?: string; releaseDate?: string }
  if (!y?.version) throw new Error('Update feed is missing a version')
  const files = (y.files ?? []).filter((f) => f?.url && f?.sha512)
  if (files.length === 0 && y.path && y.sha512) files.push({ url: y.path, sha512: y.sha512, size: 0 })
  return { version: y.version, files, ...(y.releaseDate ? { releaseDate: y.releaseDate } : {}) }
}

/** Choose the right asset for this machine: NSIS .exe on Windows, .zip on macOS (swappable bundle). */
export function pickUpdateFile(info: LatestInfo, platform: string, arch: string): UpdateFile | null {
  const want = platform === 'win32' ? /\.exe$/i : platform === 'darwin' ? /\.zip$/i : /\.AppImage$/i
  const archTag = platform === 'win32' ? (arch === 'arm64' ? 'arm64' : 'x64') : arch
  const candidates = info.files.filter((f) => want.test(f.url))
  return candidates.find((f) => f.url.includes(`-${archTag}`)) ?? candidates[0] ?? null
}

export const feedFileName = (platform: string) =>
  platform === 'darwin' ? 'latest-mac.yml' : platform === 'linux' ? 'latest-linux.yml' : 'latest.yml'
