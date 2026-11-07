import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { canonicalStyle, cssVars, DEFAULT_STYLE, gradientStops, parseColor, rgba, rgbToHsl, STYLE_FIELDS, STYLE_SCHEMA, validateStyle } from './style'

const setPath = (obj: Record<string, unknown>, path: string, value: unknown) => {
  const keys = path.split('.')
  let cur = obj
  for (const k of keys.slice(0, -1)) cur = (cur[k] ??= {}) as Record<string, unknown>
  cur[keys[keys.length - 1]!] = value
}
const patchAt = (path: string, value: unknown) => { const o: Record<string, unknown> = {}; setPath(o, path, value); return o }

describe('schema', () => {
  it('has the expected groups', () => {
    expect(Object.keys(STYLE_SCHEMA)).toEqual(['photo', 'overlay', 'text', 'shadow', 'title', 'reciter', 'meta', 'dividers', 'frame', 'output'])
  })
  it('lists every knob with a dotted path', () => {
    expect(STYLE_FIELDS.length).toBeGreaterThan(60)
    expect(STYLE_FIELDS.map((f) => f.path)).toContain('reciter.pill.opacity')
    expect(STYLE_FIELDS.map((f) => f.path)).toContain('dividers.belowTitle.color')
  })
  it('every default is inside its own range and validates', () => {
    for (const { path, field } of STYLE_FIELDS) {
      if (field.kind === 'number') { expect(field.default, path).toBeGreaterThanOrEqual(field.min); expect(field.default, path).toBeLessThanOrEqual(field.max) }
      else if (field.kind === 'font') expect(field.options.some((o) => o.id === field.default), path).toBe(true)
      else expect(parseColor(field.default), path).not.toBeNull()
    }
    expect(validateStyle(DEFAULT_STYLE)).toEqual({ ok: true, style: DEFAULT_STYLE })
  })
})

describe('validateStyle', () => {
  it('empty or absent style resolves to the defaults', () => {
    expect(validateStyle({})).toEqual({ ok: true, style: DEFAULT_STYLE })
    expect(validateStyle(undefined)).toEqual({ ok: true, style: DEFAULT_STYLE })
  })
  it('accepts every min and max, rejects one step beyond, naming the key', () => {
    for (const { path, field } of STYLE_FIELDS) {
      if (field.kind !== 'number') continue
      expect(validateStyle(patchAt(path, field.min)).ok, `${path} min`).toBe(true)
      expect(validateStyle(patchAt(path, field.max)).ok, `${path} max`).toBe(true)
      const below = validateStyle(patchAt(path, field.min - 0.001))
      expect(below.ok, `${path} below`).toBe(false)
      if (!below.ok) expect(below.errors[0]!.key).toBe(path)
      const above = validateStyle(patchAt(path, field.max + 0.001))
      expect(above.ok, `${path} above`).toBe(false)
    }
  })
  it('rejects unknown knobs, wrong types and bad colours, listing every problem', () => {
    const r = validateStyle({ title: { scale: 'big', colour: '#fff', color: 'gold' }, photo: 'none', nope: 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.map((e) => e.key).sort()).toEqual(['nope', 'photo', 'title.color', 'title.colour', 'title.scale'])
  })
  it('merges a partial patch over the defaults', () => {
    const r = validateStyle({ title: { scale: 0.8 }, meta: { pill: { opacity: 0.5 } } })
    expect(r.ok && r.style.title.scale).toBe(0.8)
    expect(r.ok && r.style.title.color).toBe(DEFAULT_STYLE.title.color)
    expect(r.ok && r.style.meta.pill.opacity).toBe(0.5)
    expect(r.ok && r.style.meta.pill.paddingX).toBe(DEFAULT_STYLE.meta.pill.paddingX)
  })
})

describe('colours', () => {
  it('parses every accepted format', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 })
    expect(parseColor('#D6B33C')).toEqual({ r: 214, g: 179, b: 60, a: 1 })
    expect(parseColor('#D6B33C80')!.a).toBeCloseTo(0.502, 2)
    expect(parseColor('rgb(1, 2, 3)')).toEqual({ r: 1, g: 2, b: 3, a: 1 })
    expect(parseColor('rgba(1,2,3,0.5)')).toEqual({ r: 1, g: 2, b: 3, a: 0.5 })
    expect(parseColor('rgb(1 2 3 / 50%)')).toEqual({ r: 1, g: 2, b: 3, a: 0.5 })
  })
  it('rejects anything else', () => {
    for (const bad of ['gold', '#ggg', 'rgb(1,2)', 'rgb(300,0,0)', 'rgba(1,2,3,2)', 123, null]) expect(parseColor(bad), String(bad)).toBeNull()
  })
  it('derives the locked gold gradient stops from the base gold', () => {
    const { light, deep } = gradientStops(parseColor('#D6B33C')!, 1)
    expect(rgba(light)).toBe('rgba(235, 210, 122, 1)')   // #EBD27A
    expect(rgba(deep)).toBe('rgba(185, 150, 43, 1)')     // #B9962B
  })
  it('treats other colours the same way; spread 0 is flat', () => {
    const teal = parseColor('#2A9D8F')!
    const { light, deep } = gradientStops(teal, 1)
    expect(rgbToHsl(light).l).toBeGreaterThan(rgbToHsl(teal).l)
    expect(rgbToHsl(deep).l).toBeLessThan(rgbToHsl(teal).l)
    const flat = gradientStops(teal, 0)
    expect(rgba(flat.light)).toBe(rgba(teal)); expect(rgba(flat.deep)).toBe(rgba(teal))
  })
})

describe('cssVars (defaults reproduce the locked design)', () => {
  const v = cssVars(DEFAULT_STYLE)
  it('title', () => {
    expect(v['--title-size']).toBe('290px')
    expect(v['--title-gradient']).toBe('linear-gradient(180deg, rgba(235, 210, 122, 1) 0%, rgba(214, 179, 60, 1) 55%, rgba(185, 150, 43, 1) 100%)')
    expect(v['--title-filter']).toBe('drop-shadow(0 4px 6px rgba(0, 0, 0, 0.451)) drop-shadow(0 10px 28px rgba(0, 0, 0, 0.451)) drop-shadow(0 0 22px rgba(235, 210, 122, 0.3))')
  })
  it('text group and lines', () => {
    expect(v['--text-offset-y']).toBe('-30px')
    expect(v['--title-max-w']).toBe('1040px')
    expect(v['--secondary-max-w']).toBe('1000px')
    expect(v['--text-shadow']).toBe('2px 12px rgba(0, 0, 0, 0.55)')
    expect(v['--meta-color']).toBe('rgba(244, 239, 227, 0.82)')
    expect(v['--sep-size']).toBe('7px')
    expect(v['--reciter-pill-bg']).toBe('transparent')
    expect(v['--frame-display']).toBe('none')
    expect(v['--div-above-display']).toBe('none')
  })
  it('overlay', () => {
    expect(v['--overlay-bg']).toContain('linear-gradient(180deg, rgba(11, 26, 38, 0.22) 0%, rgba(11, 26, 38, 0.46) 45%, rgba(11, 26, 38, 0.84) 100%)')
    expect(v['--overlay-bg']).toContain('radial-gradient(58% 60% at calc(50% + 0px) calc(52% + 0px)')
  })
  it('zero opacities hide lines', () => {
    const r = validateStyle({ reciter: { opacity: 0 }, meta: { dateOpacity: 0 } })
    const w = cssVars(r.ok ? r.style : DEFAULT_STYLE)
    expect(w['--reciter-display']).toBe('none')
    expect(w['--date-display']).toBe('none')
    expect(w['--sep-display']).toBe('none')
    expect(w['--meta-display']).toBe('flex')
  })
})

describe('canonicalStyle', () => {
  it('is schema-ordered regardless of input order', () => {
    const a = validateStyle({ meta: { gap: 0.6 }, title: { scale: 0.9 } }), b = validateStyle({ title: { scale: 0.9 }, meta: { gap: 0.6 } })
    expect(a.ok && b.ok && canonicalStyle(a.style)).toBe(b.ok && canonicalStyle(b.style))
    expect(canonicalStyle(DEFAULT_STYLE).startsWith('{"photo":{"focusX":50')).toBe(true)
  })
})

describe('samples/style-template.json', () => {
  it('lists every knob at its default, nothing more', () => {
    const raw = JSON.parse(readFileSync(new URL('./samples/style-template.json', import.meta.url), 'utf8')) as Record<string, unknown>
    delete raw['_comment']
    expect(raw).toEqual(DEFAULT_STYLE)
  })
})

describe('fonts', () => {
  it('accepts bundled ids and absolute font paths, rejects the rest', () => {
    expect(validateStyle({ reciter: { font: 'cairo' }, meta: { font: 'aref-ruqaa' } }).ok).toBe(true)
    expect(validateStyle({ reciter: { font: '/Users/me/fonts/MyFont.ttf' } }).ok).toBe(true)
    expect(validateStyle({ meta: { font: '/x/y.WOFF2' } }).ok).toBe(true)
    for (const bad of ['Cairo', 'fonts/x.ttf', '/x/y.txt', '', 42]) {
      const r = validateStyle({ reciter: { font: bad } })
      expect(r.ok, String(bad)).toBe(false)
      if (!r.ok) expect(r.errors[0]!.key).toBe('reciter.font')
    }
  })
  it('maps fonts to CSS family + weight', () => {
    const r = validateStyle({ reciter: { font: 'katibeh' }, meta: { font: '/x/My.ttf' } })
    const v = cssVars(r.ok ? r.style : DEFAULT_STYLE)
    expect(v['--reciter-font']).toBe('"katibeh"'); expect(v['--reciter-weight']).toBe('400')
    expect(v['--meta-font']).toBe('"custom-meta"'); expect(v['--meta-weight']).toBe('500')
    expect(cssVars(DEFAULT_STYLE)['--reciter-font']).toBe('"amiri"')
    expect(cssVars(DEFAULT_STYLE)['--meta-font']).toBe('"ibm-plex-sans-arabic"')
  })
})

describe('bundled font files', () => {
  it('every declared file exists in template/fonts and every id is unique', async () => {
    const { BUNDLED_FONTS } = await import('./fonts')
    const { existsSync } = await import('node:fs')
    const ids = new Set<string>()
    for (const f of BUNDLED_FONTS) {
      expect(ids.has(f.id), f.id).toBe(false); ids.add(f.id)
      for (const [file] of f.files) expect(existsSync(new URL(`./template/fonts/${file}`, import.meta.url)), file).toBe(true)
    }
    expect(BUNDLED_FONTS.length).toBe(21)
  })
})
