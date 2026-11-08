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

/** A response-like shape so the retry helper can be tested without the network. */
export interface FetchLike { (url: string, init?: RequestInit): Promise<{ ok: boolean; status: number } & Record<string, unknown>> }

/** HTTP statuses worth another try: the server or a gateway in front of it hiccupped, not us. */
export const isTransientStatus = (status: number): boolean => status === 408 || status === 429 || status >= 500

/** Plain words for a failed feed/download response; `finalUrl` names the host that actually answered (after redirects). */
export function describeHttpFailure(what: string, status: number, finalUrl?: string): string {
  let host = ''
  try { if (finalUrl) host = ` from ${new URL(finalUrl).host}` } catch { /* not a URL */ }
  if (isTransientStatus(status)) return `GitHub's ${what} didn't answer (HTTP ${status}${host}). This is usually brief — try again in a few minutes.`
  if (status === 404) return `GitHub's ${what} has no file for this release yet (HTTP 404${host}). Try again later.`
  return `GitHub's ${what} refused the request (HTTP ${status}${host}).`
}

/** The GitHub REST view of a release: enough to find an asset's API download URL when the public path is failing. */
export interface ReleaseAsset { name: string; url: string; browser_download_url?: string }
export interface ReleaseInfo { tag_name?: string; body?: string; html_url?: string; assets?: ReleaseAsset[] }
export const assetApiUrl = (release: ReleaseInfo | null | undefined, name: string): string | null =>
  release?.assets?.find((a) => a.name === name)?.url ?? null

/**
 * fetch with a few retries on transient failures (network errors, 5xx, 429/408), waiting `delaysMs[i]`
 * between attempts. A non-transient response is returned as-is for the caller to judge; the last
 * transient response is returned too, so the caller can report its status.
 */
export async function fetchWithRetry<R extends { ok: boolean; status: number }>(
  fetchFn: (url: string, init?: RequestInit) => Promise<R>, url: string, init?: RequestInit,
  delaysMs: readonly number[] = [2000, 6000], sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<R> {
  let lastError: unknown
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetchFn(url, init)
      if (res.ok || !isTransientStatus(res.status) || attempt >= delaysMs.length) return res
    } catch (e) {
      lastError = e
      if (attempt >= delaysMs.length) throw e
    }
    await sleep(delaysMs[attempt]!)
  }
}
