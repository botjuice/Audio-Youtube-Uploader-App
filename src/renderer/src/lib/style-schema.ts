import { useEffect, useState } from 'react'
import type { StyleSchemaInfo } from '@shared/types'

let cache: StyleSchemaInfo | null = null
let inflight: Promise<StyleSchemaInfo> | null = null

/** The plugin's knob schema (labels, kinds, defaults), fetched once per session. */
export function useStyleSchema(): StyleSchemaInfo | null {
  const [schema, setSchema] = useState<StyleSchemaInfo | null>(cache)
  useEffect(() => {
    if (cache) return
    inflight ??= window.api.getStyleSchema().then((s) => (cache = s))
    let live = true
    void inflight.then((s) => { if (live) setSchema(s) })
    return () => { live = false }
  }, [])
  return schema
}
