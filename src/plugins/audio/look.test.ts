import { describe, expect, it } from 'vitest'
import { CATALOG, filterInfo, optionInfo, padCount } from './catalog'
import { parseFilterHelp } from './catalog-gen'
import { buildGraph, errorsByStep, escapeValue, filterText } from './graph'
import { describeLook, EMPTY_LOOK, filtersUsed, validateLook, walkSteps, type Look } from './look'
import { LOOK_PRESETS } from './presets'
import { isV1Look, lookFromV1 } from './v1'
import { parseEbur, parseOutputStream, parseProbe, percentile } from './ffmpeg'

const valid = (x: unknown): Look => { const v = validateLook(x); if (!v.ok) throw new Error(JSON.stringify(v.errors)); return v.look }
const errorsOf = (x: unknown) => { const v = validateLook(x); return v.ok ? [] : v.errors }

describe('filtersUsed', () => {
  it('lists every filter a look runs with its place: steps, branches, merges and generated sources, not bypassed steps', () => {
    const look = valid({ chain: [
      { filter: 'highpass' }, { filter: 'afftdn', bypass: true },
      { filter: 'amix', inputs: [{ kind: 'generate', filter: 'sine', chain: [{ filter: 'volume', options: { volume: 0.1 } }] }] },
      { filter: 'acrossover', options: { split: '2000' }, outputs: [[], [{ filter: 'aecho' }]], merge: { filter: 'amix', options: { inputs: 2 } } },
    ] })
    expect(filtersUsed(look).map((u) => `${u.path} ${u.filter}`)).toEqual([
      'chain[0] highpass', 'chain[2] amix', 'chain[2].inputs[0] sine', 'chain[2].inputs[0].chain[0] volume',
      'chain[3] acrossover', 'chain[3].outputs[1][0] aecho', 'chain[3].merge amix',
    ])
  })
})

describe('catalog (generated from the bundled ffmpeg)', () => {
  it('has every audio filter, with roles that cover all of them', () => {
    const all = Object.values(CATALOG.filters)
    expect(CATALOG.ffmpeg).toMatch(/^ffmpeg version 6\.0/)
    expect(all.length).toBeGreaterThan(130)
    expect(new Set(all.map((f) => f.role))).toEqual(new Set(['effect', 'split', 'multi-input', 'source']))
    expect(all.filter((f) => f.role === 'split').map((f) => f.name).sort()).toEqual(['acrossover', 'asegment', 'aselect', 'asplit', 'channelsplit'])
    for (const name of ['afftdn', 'acompressor', 'sidechaincompress', 'afir', 'acrossover', 'amix', 'sine', 'loudnorm', 'firequalizer', 'arnndn']) expect(filterInfo(name), name).toBeTruthy()
    for (const name of ['amovie', 'abuffersink', 'showspectrum']) expect(filterInfo(name), name).toBeUndefined()
  })

  it('keeps ffmpeg\'s exact limits, defaults, choices and aliases', () => {
    const nr = optionInfo('afftdn', 'nr')!
    expect(nr).toMatchObject({ name: 'noise_reduction', aliases: ['nr'], type: 'float', min: 0.01, max: 97, default: '12', live: true })
    const nt = optionInfo('afftdn', 'noise_type')!
    expect(nt.choices).toBe(true)
    expect(nt.constants![0]).toMatchObject({ name: 'white', value: 0, aliases: ['w'] })
    expect(optionInfo('aresample', 'filter_size')).toMatchObject({ min: 0, max: 2147483647, group: 'SWResampler' })   // INT_MAX resolved
    expect(optionInfo('afir', 'response')).toBeUndefined()   // video-only option dropped
    for (const f of Object.values(CATALOG.filters)) for (const o of f.options) {
      if (o.min !== undefined && o.default !== undefined && Number.isFinite(Number(o.default))) {
        expect(Number(o.default), `${f.name}.${o.name}`).toBeGreaterThanOrEqual(o.min)
        expect(Number(o.default), `${f.name}.${o.name}`).toBeLessThanOrEqual(o.max!)
      }
    }
  })

  it('parses ffmpeg help text: pads, ranges, named limits, choices, alias rows', () => {
    const help = `Filter demo
  A demo.
    Inputs:
       #0: main (audio)
       #1: sidechain (audio)
    Outputs:
        dynamic (depending on the options)
demo AVOptions:
   level             <double>     ..F.A....T. set level (from -1 to DBL_MAX) (default 0.5)
   l                 <double>     ..F.A....T. set level (from -1 to DBL_MAX) (default 0.5)
   mode              <int>        ..F.A...... pick (from 0 to 1) (default fast)
     fast            0            ..F.A...... quick
     f               0            ..F.A...... quick
     slow            1            ..F.A...... careful
   size              <image_size> ..FV....... video size (default "hd720")
   list              <string>     ..F.A...... a list (default "1 2")

This filter has support for timeline through the 'enable' option.`
    const f = parseFilterHelp('demo', help)
    expect(f.inputs).toEqual([{ name: 'main', type: 'audio' }, { name: 'sidechain', type: 'audio' }])
    expect(f.outputs).toBe('dynamic')
    expect(f.timeline).toBe(true)
    expect(f.options.map((o) => o.name)).toEqual(['level', 'mode', 'list'])
    expect(f.options[0]).toMatchObject({ aliases: ['l'], min: -1, max: Number.MAX_VALUE, default: '0.5', live: true })
    expect(f.options[1]!.constants).toEqual([{ name: 'fast', value: 0, desc: 'quick', aliases: ['f'] }, { name: 'slow', value: 1, desc: 'careful' }])
    expect(f.options[2]!.default).toBe('1 2')
  })

  it('padCount follows the options for the common dynamic filters', () => {
    expect(padCount('acrossover', { split: '300 3000' }, 'out')).toBe(3)
    expect(padCount('asplit', {}, 'out')).toBe(2)
    expect(padCount('amix', { inputs: 4 }, 'in')).toBe(4)
    expect(padCount('afir', {}, 'in')).toBe(2)
    expect(padCount('afir', {}, 'out')).toBe(1)
    expect(padCount('sidechaincompress', {}, 'in')).toBe(2)
    expect(padCount('channelsplit', {}, 'out')).toBeNull()
  })

  it('video-switched filters are plain effects; aphasemeter\'s video output is always written off', () => {
    for (const n of ['aphasemeter', 'ebur128', 'anequalizer', 'aiir']) expect(filterInfo(n)!.role, n).toBe('effect')
    expect(buildGraph(valid({ chain: [{ filter: 'aphasemeter' }] }), { mode: 'chain' }).graph).toBe('[0:a]aphasemeter=video=false[a1];[a1]anull[out]')
  })
})

describe('validateLook', () => {
  it('empty and preset looks are valid', () => {
    expect(valid({})).toEqual(EMPTY_LOOK)
    for (const [k, p] of Object.entries(LOOK_PRESETS)) expect(validateLook(p.look).ok, k).toBe(true)
  })

  it('normalises aliases, numeric strings and booleans', () => {
    const l = valid({ chain: [{ filter: 'afftdn', options: { nr: '20', tn: 1, nt: 'v' } }] })
    expect(l.chain[0]!.options).toEqual({ noise_reduction: 20, track_noise: true, noise_type: 'v' })
  })

  it('allows ffmpeg\'s full range and nothing beyond it', () => {
    expect(validateLook({ chain: [{ filter: 'highpass', options: { f: 999999 } }] }).ok).toBe(true)
    const e = errorsOf({ chain: [{ filter: 'highpass', options: { f: 1000000 } }] })
    expect(e).toEqual([{ path: 'chain[0].options.f', message: 'frequency is above the maximum (ffmpeg allows 0 to 999999)' }])
    expect(errorsOf({ chain: [{ filter: 'highpass', options: { poles: 1.5 } }] })[0]!.message).toBe('poles must be a whole number')
  })

  it('names every problem with its path', () => {
    const e = errorsOf({
      chain: [
        { filter: 'nope' },
        { filter: 'volume', options: { loudness: 3 } },
        { filter: 'afftdn', options: { nt: 'pink' } },
        { filter: 'aresample', enable: 't>1' },
        { filter: 'sine' },
        { filter: 'sidechaincompress' },
        { filter: 'acrossover', options: { split: '200 2000' }, outputs: [[], []], merge: { filter: 'amix' } },
      ],
      extra: 1,
    })
    expect(e.map((x) => x.path)).toEqual(['extra', 'chain[0].filter', 'chain[1].options.loudness', 'chain[2].options.nt', 'chain[3].enable', 'chain[4].filter', 'chain[5].inputs', 'chain[6].outputs'])
    expect(e.find((x) => x.path === 'chain[5].inputs')!.message).toBe('sidechaincompress needs 1 extra input with these options, the step has 0')
  })

  it('checks branches against their merge', () => {
    const e = errorsOf({ chain: [{ filter: 'asplit', options: { outputs: 3 }, outputs: [[], [], []], merge: { filter: 'amix' } }] })
    expect(e).toEqual([{ path: 'chain[0].merge', message: 'amix takes 2 inputs with these options, but there are 3 branches (set inputs: 3)' }])
    expect(errorsOf({ chain: [{ filter: 'asplit', outputs: [[], []] }] })[0]!.path).toBe('chain[0].merge')
    expect(errorsOf({ chain: [{ filter: 'asplit', outputs: [[], []], merge: { filter: 'volume' } }] }).map((x) => x.path)).toContain('chain[0].merge.filter')
  })

  it('caps branches so a huge output count can\'t build a giant graph', () => {
    expect(errorsOf({ chain: [{ filter: 'asplit', options: { outputs: 1000000 }, outputs: [[], []], merge: { filter: 'amix' } }] })[0]).toEqual({ path: 'chain[0].options', message: 'asplit would have 1000000 outputs; the plugin allows 64' })
    expect(errorsOf({ chain: [{ filter: 'asplit', options: { outputs: 65 }, outputs: Array.from({ length: 65 }, () => []), merge: { filter: 'amix', options: { inputs: 65 } } }] }).map((e) => e.path)).toContain('chain[0].outputs')
  })

  it('refuses settings the sweep found crash ffmpeg 6.0, and filters missing what they need', () => {
    expect(errorsOf({ chain: [{ filter: 'aeval' }] })).toEqual([{ path: 'chain[0].options.exprs', message: 'aeval needs an expression per channel (ffmpeg 6.0 crashes without one)' }])
    expect(errorsOf({ chain: [{ filter: 'chorus', options: { delays: '40' } }] }).map((e) => e.path)).toEqual(['chain[0].options.decays', 'chain[0].options.speeds', 'chain[0].options.depths'])
    expect(validateLook({ chain: [{ filter: 'asegment', options: { samples: '100' }, outputs: [[], []], merge: { filter: 'amix' } }] }).ok).toBe(true)
    expect(errorsOf({ chain: [{ filter: 'afir', options: { ir: 1 }, inputs: [{ kind: 'signal' }] }] })[0]).toEqual({ path: 'chain[0].options.ir', message: 'ir must be below nbirs (1)' })
  })

  it('level is optional and bounded', () => {
    expect(valid({ level: { lufs: -16 } }).level).toEqual({ lufs: -16, ceiling: -1.5 })
    expect(valid({ level: null }).level).toBeUndefined()
    expect(errorsOf({ level: { lufs: 3 } })[0]!.path).toBe('level.lufs')
  })

  it('describes a look in one line', () => {
    expect(describeLook(valid(LOOK_PRESETS.cleanup!.look))).toBe('adeclick → highpass frequency=75 poles=2 → highpass frequency=75 poles=2 → afftdn noise_reduction=12 noise_floor=-42 track_noise=true · level -14 LUFS, ceiling -1.5 dBTP')
    expect(describeLook(EMPTY_LOOK)).toBe('no effects')
    const paths: string[] = []
    walkSteps(valid(LOOK_PRESETS.springTamer!.look), (s, p) => paths.push(`${p}=${s.filter}`))
    expect(paths).toEqual(['chain[0]=acrossover', 'chain[0].outputs[1][0]=sidechaincompress', 'chain[0].outputs[1][0].inputs[0].chain[0]=adelay', 'chain[0].merge=amix'])
  })
})

describe('graph', () => {
  it('escapes values for both ffmpeg parsing levels', () => {
    expect(escapeValue('plain')).toBe('plain')
    expect(escapeValue('a:b')).toBe('a\\\\:b')
    expect(escapeValue('if(gt(t,1),2,3)')).toBe('if(gt(t\\,1)\\,2\\,3)')
    expect(escapeValue('[x];y')).toBe('\\[x\\]\\;y')
    expect(escapeValue(' a ')).toBe('\\\\ a\\\\\\ ')   // proven by a round trip through ffmpeg (process.test)
    expect(filterText('volume', { volume: 0.5, eval: 'frame' }, 'between(t,1,2)')).toBe('volume=volume=0.5:eval=frame:enable=between(t\\,1\\,2)')
  })

  it('a plain chain, then gain and a 4× oversampled limiter in render mode', () => {
    const look = valid({ chain: [{ filter: 'highpass', options: { f: 80 } }, { filter: 'volume', options: { volume: 2 }, bypass: true }, { filter: 'afftdn' }] })
    expect(buildGraph(look, { mode: 'chain' }).graph).toBe('[0:a]highpass=frequency=80[a1];[a1]afftdn[a2];[a2]anull[out]')
    expect(buildGraph(look, { mode: 'render', gainDb: 3.25, ceiling: -1.5, rate: 48000 }).graph)
      .toBe('[0:a]highpass=frequency=80[a1];[a1]afftdn[a2];[a2]volume=3.25dB,aresample=192000,alimiter=limit=0.841395:level=false:attack=5:release=50:latency=true,aresample=48000[out]')
    expect(buildGraph(EMPTY_LOOK, { mode: 'measure' }).graph).toBe('[0:a]ebur128=peak=sample:framelog=verbose[out]')
  })

  it('splits, sidechains, files and generated inputs, with step paths for every filter', () => {
    const look = valid({
      chain: [
        { filter: 'acrossover', options: { split: '4500' }, outputs: [[], [{ filter: 'sidechaincompress', inputs: [{ kind: 'signal', chain: [{ filter: 'adelay', options: { delays: '120' } }] }] }]], merge: { filter: 'amix', options: { inputs: 2 } } },
        { filter: 'afir', inputs: [{ kind: 'file', path: '/ir/hall.wav' }] },
        { filter: 'amix', options: { inputs: 2 }, inputs: [{ kind: 'generate', filter: 'anoisesrc', options: { amplitude: 0.01 } }] },
      ],
    })
    const g = buildGraph(look, { mode: 'chain' })
    expect(g.graph).toBe(
      '[0:a]acrossover=split=4500[a1][a2];[a2]asplit=outputs=2[a3][a4];[a4]adelay=delays=120[a5];[a3][a5]sidechaincompress[a6];[a1][a6]amix=inputs=2[a7];'
      + '[a7][1:a]afir[a8];anoisesrc=amplitude=0.01[a9];[a8][a9]amix=inputs=2[a10];[a10]anull[out]')
    expect(g.files).toEqual(['/ir/hall.wav'])
    expect(g.filePaths).toEqual(['chain[1].inputs[0]'])
    expect(g.filterPaths).toEqual(['chain[0]', '', 'chain[0].outputs[1][0].inputs[0].chain[0]', 'chain[0].outputs[1][0]', 'chain[0].merge', 'chain[1]', 'chain[2].inputs[0]', 'chain[2]', ''])
    // Windows prints the address without 0x and ends lines with \r\n
    expect(errorsByStep("[Parsed_adelay_2 @ 000001E5C0D5B0C0] Delay must be positive\r\n[Parsed_afir_5 @ 000001e5c0d5b0c0] Too short\r\n", g.filterPaths)).toEqual(errorsByStep("[Parsed_adelay_2 @ 0x7f8] Delay must be positive\n[Parsed_afir_5 @ 0x1] Too short", g.filterPaths))
    expect(errorsByStep("[Parsed_adelay_2 @ 000001E5C0D5B0C0] Delay must be positive\r\n", g.filterPaths)).toHaveLength(1)
    expect(errorsByStep("[Parsed_adelay_2 @ 0x7f8] Delay must be positive\n[Parsed_afir_5 @ 0x1] Too short\nThe filters 'Parsed_afir_5' and 'format_out_0_0' do not have a common format", g.filterPaths)).toEqual([
      { path: 'chain[0].outputs[1][0].inputs[0].chain[0]', message: 'adelay: Delay must be positive' },
      { path: 'chain[1]', message: 'afir: Too short' },
      { path: 'chain[1]', message: "afir: The filters 'afir' and 'format_out_0_0' do not have a common format" },
    ])
  })
})

describe('parsers', () => {
  it('reads stream facts from an ffmpeg banner', () => {
    expect(parseProbe('  Duration: 00:07:28.83, start: 0.000000, bitrate: 259 kb/s\n  Stream #0:0[0x1](eng): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, mono, fltp, 256 kb/s (default)'))
      .toEqual({ durationSec: 448.83, sampleRate: 48000, channels: 1, codec: 'aac' })
    expect(parseProbe('Duration: 00:00:01.00\n Stream #0:0: Audio: flac, 48000 Hz, stereo, s32 (24 bit)')!.channels).toBe(2)
    expect(parseProbe('nothing here')).toBeNull()
    // ffmpeg cuts a very long layout short, with no comma after it
    expect(parseProbe('Duration: 00:00:01.00\n  Stream #0:0: Audio: pcm_s16le, 44100 Hz, 64 channels (FL+FR+FC+USR4\n')!.channels).toBe(64)
    expect(parseOutputStream('Input #0 …\nStream #0:0: Audio: aac, 48000 Hz, mono\nOutput #0, null, to \'pipe:\':\n  Stream #0:0: Audio: pcm_s16le, 96000 Hz, stereo, s16, 3072 kb/s')).toEqual({ sampleRate: 96000, channels: 2 })
  })

  it('reads the ebur128 summary: loudness, sample peak and true peak', () => {
    const both = '[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         -14.7 LUFS\n\n  Loudness range:\n    LRA:         4.2 LU\n\n  Sample peak:\n    Peak:       -1.2 dBFS\n\n  True peak:\n    Peak:       -0.9 dBFS'
    expect(parseEbur(both)).toEqual({ lufs: -14.7, lra: 4.2, samplePeak: -1.2, truePeak: -0.9 })
    expect(parseEbur('Summary:\n    I:         -70.0 LUFS\n    LRA:         0.0 LU\n  True peak:\n    Peak:       -inf dBFS')).toEqual({ lufs: -70, lra: 0, truePeak: -Infinity, samplePeak: -Infinity })
    expect(parseEbur('no summary')).toBeNull()
  })

  it('percentile', () => {
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3)
    expect(percentile([], 0.5)).toBe(-Infinity)
  })
})

describe('v1 looks', () => {
  it('the v1 default becomes the cleanup preset plus its fade-in', () => {
    expect(isV1Look({})).toBe(false)
    expect(isV1Look({ cleanup: { hiss: { amount: 14 } } })).toBe(true)
    expect(isV1Look({ chain: [] })).toBe(false)
    const l = valid(lookFromV1({}))
    expect(l.chain.slice(0, 4)).toEqual(LOOK_PRESETS.cleanup!.look.chain)
    expect(l.chain[4]).toEqual({ filter: 'afade', options: { type: 'in', start_time: 0, duration: 0.5 } })
    expect(l.level).toEqual({ lufs: -14, ceiling: -1.5 })
  })

  it('every v1 section maps onto valid filters with v1\'s values', () => {
    const l = valid(lookFromV1({
      cleanup: { declip: { enabled: true }, hiss: { enabled: false } },
      tone: { enabled: true, air: { gain: 2 }, deesser: 0.2 },
      dynamics: { enabled: true, threshold: -20 },
      reverb: { enabled: true, decay: 2.2, predelay: 25 },
      loudness: { enabled: false },
      fades: { in: 0 },
    }))
    expect(l.chain.map((s) => s.filter)).toEqual(['adeclip', 'adeclick', 'highpass', 'highpass', 'equalizer', 'equalizer', 'treble', 'deesser', 'acompressor', 'asplit'])
    expect(l.chain[8]!.options!.threshold).toBeCloseTo(0.1, 6)
    expect(l.level).toBeUndefined()
  })
})
