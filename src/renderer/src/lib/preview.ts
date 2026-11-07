import { useEffect, useRef, useState } from 'react'
import type { StylePatch, ThumbnailPreview, ThumbnailSample } from '@shared/types'
import { errText, useStore } from '@/store'

// Shared preview hook: debounced, out-of-order safe, memoised across cards and pages.
const previewCache = new Map<string, ThumbnailPreview>()

export function useStyledPreview(sample: ThumbnailSample, style: StylePatch, photo?: string, enabled = true, delay = 250) {
  const sheikh = useStore((s) => s.settings?.thumbnails.sheikhPrefix ?? true)
  // The reciter's photo and name are part of the render, so a new photo in the folder re-renders too.
  const reciter = useStore((s) => s.library.reciters.find((r) => r.folder === sample.folder) ?? s.library.reciters[0])
  const key = JSON.stringify([sample, style, sheikh, photo ?? null, reciter?.imagePath ?? null, reciter?.nameAr ?? null])
  const [result, setResult] = useState<ThumbnailPreview | null>(() => previewCache.get(key) ?? null)
  const [rendering, setRendering] = useState(false)
  const seq = useRef(0)
  useEffect(() => {
    if (!enabled) return
    const hit = previewCache.get(key)
    if (hit) { setResult(hit); setRendering(false); return }
    const mine = ++seq.current
    setRendering(true)
    const t = setTimeout(async () => {
      let r: ThumbnailPreview
      try { r = await window.api.renderStyled({ sample, style, sheikhPrefix: sheikh, ...(photo ? { photo } : {}) }) }
      catch (e) { r = { ok: false, reason: 'RENDER_FAILED', message: errText(e) } }
      if (r.ok) previewCache.set(key, r)
      if (mine === seq.current) { setResult(r); setRendering(false) }
    }, delay)
    return () => clearTimeout(t)
  }, [key, enabled])  // eslint-disable-line react-hooks/exhaustive-deps
  return { result, rendering }
}
