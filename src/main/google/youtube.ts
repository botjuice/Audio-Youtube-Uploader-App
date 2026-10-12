import { promises as fs } from 'node:fs'
import type { Playlist, Privacy } from '@shared/types'
import { accessToken } from './oauth'

const API = 'https://www.googleapis.com/youtube/v3'
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3/videos'

/** Turn a Google API error payload into a message the user can act on. */
export async function friendlyError(res: Response): Promise<Error> {
  let reason = ''
  let message = `${res.status} ${res.statusText}`
  try {
    const j = (await res.json()) as { error?: { message?: string; errors?: { reason?: string }[]; status?: string } }
    message = j.error?.message ?? message
    reason = j.error?.errors?.[0]?.reason ?? j.error?.status ?? ''
  } catch { /* non-JSON */ }
  const hints: Record<string, string> = {
    quotaExceeded: 'YouTube API daily quota is used up. It resets at midnight Pacific time.',
    dailyLimitExceeded: 'YouTube API daily quota is used up. It resets at midnight Pacific time.',
    uploadLimitExceeded: 'YouTube says this channel has hit its upload limit for now. Verify the channel (phone) to raise it, or wait.',
    forbidden: 'Google refused the request. Reconnect Google and make sure you chose the right channel.',
    insufficientPermissions: 'The connected account lacks permission. Disconnect and reconnect, accepting both YouTube permissions.',
    invalidTitle: 'YouTube rejected the title (too long or contains < >).',
    playlistNotFound: 'That playlist no longer exists on your channel.',
    videoNotFound: 'YouTube could not find the uploaded video (it may still be processing).',
    UNAUTHENTICATED: 'Google session expired. Reconnect Google. If your OAuth app is in "Testing" mode tokens expire every 7 days — publish it to stop that.',
  }
  const e = new Error(hints[reason] ? `${hints[reason]} (${reason})` : `${message}${reason ? ` (${reason})` : ''}`)
  ;(e as Error & { reason?: string }).reason = reason
  return e
}

async function api<T>(path: string, params: Record<string, string>, init: RequestInit = {}): Promise<T> {
  const url = new URL(`${API}/${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  if (!res.ok) throw await friendlyError(res)
  return (res.status === 204 ? ({} as T) : ((await res.json()) as T))
}

export interface Channel { id: string; title: string; uploadsPlaylist: string }

export async function getChannel(): Promise<Channel> {
  const j = await api<{ items?: { id: string; snippet: { title: string }; contentDetails: { relatedPlaylists: { uploads: string } } }[] }>(
    'channels', { part: 'snippet,contentDetails', mine: 'true' })
  const ch = j.items?.[0]
  if (!ch) throw new Error('This Google account has no YouTube channel')
  return { id: ch.id, title: ch.snippet.title, uploadsPlaylist: ch.contentDetails.relatedPlaylists.uploads }
}

export async function listPlaylists(): Promise<Playlist[]> {
  const out: Playlist[] = []
  let pageToken = ''
  do {
    const j = await api<{ items?: { id: string; snippet: { title: string }; status?: { privacyStatus?: string }; contentDetails?: { itemCount?: number } }[]; nextPageToken?: string }>(
      'playlists', { part: 'snippet,status,contentDetails', mine: 'true', maxResults: '50', ...(pageToken ? { pageToken } : {}) })
    for (const p of j.items ?? []) out.push({ id: p.id, title: p.snippet.title, privacy: p.status?.privacyStatus, itemCount: p.contentDetails?.itemCount })
    pageToken = j.nextPageToken ?? ''
  } while (pageToken)
  return out
}

export async function createPlaylist(title: string, privacy: Privacy): Promise<Playlist> {
  const j = await api<{ id: string; snippet: { title: string }; status?: { privacyStatus?: string } }>(
    'playlists', { part: 'snippet,status' },
    { method: 'POST', body: JSON.stringify({ snippet: { title }, status: { privacyStatus: privacy } }) })
  return { id: j.id, title: j.snippet.title, privacy: j.status?.privacyStatus, itemCount: 0 }
}

export async function addToPlaylist(playlistId: string, videoId: string): Promise<void> {
  await api('playlistItems', { part: 'snippet' }, {
    method: 'POST',
    body: JSON.stringify({ snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } } }),
  })
}

/** Every video on the channel (title + id), newest first. ~1 quota unit per 50 videos. */
export async function listUploads(max = 5000): Promise<{ videoId: string; title: string }[]> {
  const { uploadsPlaylist } = await getChannel()
  const out: { videoId: string; title: string }[] = []
  let pageToken = ''
  do {
    const j = await api<{ items?: { snippet: { title: string; resourceId: { videoId: string } } }[]; nextPageToken?: string }>(
      'playlistItems', { part: 'snippet', playlistId: uploadsPlaylist, maxResults: '50', ...(pageToken ? { pageToken } : {}) })
    for (const it of j.items ?? []) out.push({ videoId: it.snippet.resourceId.videoId, title: it.snippet.title })
    pageToken = j.nextPageToken ?? ''
  } while (pageToken && out.length < max)
  return out
}

export interface UploadMeta {
  title: string
  description: string
  tags: string[]
  categoryId: string
  privacy: Privacy
  madeForKids: boolean
}

const CHUNK = 8 * 1024 * 1024 // multiple of 256 KiB as Google requires

/** Resumable upload with chunked PUTs, retry-with-resume on transient failure, and real progress. */
export async function uploadVideo(
  file: string, meta: UploadMeta,
  opts: { onProgress?: (percent: number) => void; signal?: AbortSignal } = {},
): Promise<string> {
  const size = (await fs.stat(file)).size
  const body = {
    snippet: { title: meta.title, description: meta.description, tags: meta.tags, categoryId: meta.categoryId },
    status: { privacyStatus: meta.privacy, selfDeclaredMadeForKids: meta.madeForKids },
  }
  const init = await fetch(`${UPLOAD}?uploadType=resumable&part=snippet,status`, {
    method: 'POST', signal: opts.signal,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'video/mp4',
      'X-Upload-Content-Length': String(size),
    },
    body: JSON.stringify(body),
  })
  if (!init.ok) throw await friendlyError(init)
  const location = init.headers.get('location')
  if (!location) throw new Error('YouTube did not return an upload session URL')

  const fh = await fs.open(file, 'r')
  try {
    let offset = 0
    let retries = 0
    while (offset < size) {
      const len = Math.min(CHUNK, size - offset)
      const buf = Buffer.alloc(len)
      await fh.read(buf, 0, len, offset)
      let res: Response
      try {
        res = await fetch(location, {
          method: 'PUT', signal: opts.signal,
          headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Range': `bytes ${offset}-${offset + len - 1}/${size}` },
          body: buf,
        })
      } catch (e) {
        if (opts.signal?.aborted) throw new Error('Cancelled')
        if (++retries > 8) throw e
        await backoff(retries)
        offset = await queryOffset(location, size)
        continue
      }
      if (res.status === 308) {
        const range = res.headers.get('range')
        offset = range ? Number(range.split('-')[1]) + 1 : offset + len
        retries = 0
        opts.onProgress?.(Math.round((offset / size) * 100))
        continue
      }
      if (res.ok) {
        const j = (await res.json()) as { id: string }
        opts.onProgress?.(100)
        return j.id
      }
      if (res.status === 429 || res.status >= 500) {
        if (++retries > 8) throw await friendlyError(res)
        await backoff(retries)
        offset = await queryOffset(location, size)
        continue
      }
      throw await friendlyError(res)
    }
    throw new Error('Upload ended without a response from YouTube')
  } finally {
    await fh.close()
  }
}

const backoff = (n: number) => new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** n)))

async function queryOffset(location: string, size: number): Promise<number> {
  const res = await fetch(location, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Range': `bytes */${size}` },
  })
  if (res.status === 308) {
    const range = res.headers.get('range')
    return range ? Number(range.split('-')[1]) + 1 : 0
  }
  if (res.ok) return size
  throw await friendlyError(res)
}
