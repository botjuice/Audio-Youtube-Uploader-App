// Renders the app icon from SVG using Electron's own renderer (no image libs needed).
// Usage: npx electron scripts/render-icon.cjs
const { app, BrowserWindow } = require('electron')
const fs = require('fs'); const path = require('path')
const out = path.resolve(__dirname, '..', 'resources')

// ── Design ─────────────────────────────────────────────────────────────────
// Squircle in an indigo→teal gradient. A mihrab-style arch (soft white) frames a
// play mark whose right edge dissolves into three rounded waveform bars — recitation
// becoming video. Reads at 16 px as "play + sound".
const appSvg = (S) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#5457e0"/><stop offset="0.55" stop-color="#3b6fe6"/><stop offset="1" stop-color="#19b3c9"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.3" cy="0.22" r="0.75">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.28"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="archFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.22"/><stop offset="1" stop-color="#ffffff" stop-opacity="0.06"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="14" stdDeviation="18" flood-color="#0b1a4a" flood-opacity="0.35"/>
    </filter>
    <clipPath id="sq"><rect x="92" y="92" width="840" height="840" rx="196"/></clipPath>
  </defs>
  <g filter="url(#shadow)"><rect x="92" y="92" width="840" height="840" rx="196" fill="url(#bg)"/></g>
  <g clip-path="url(#sq)">
    <rect x="92" y="92" width="840" height="840" fill="url(#glow)"/>
    <!-- mihrab arch -->
    <path d="M300 790 V500 C300 360 400 262 512 236 C624 262 724 360 724 500 V790 Z"
          fill="url(#archFill)" stroke="#ffffff" stroke-opacity="0.55" stroke-width="10" stroke-linejoin="round"/>
    <!-- play mark -->
    <path d="M340 404 L340 620 L520 512 Z" fill="#ffffff" stroke="#ffffff" stroke-width="44" stroke-linejoin="round"/>
    <!-- waveform bars, kept inside the arch -->
    <rect x="556" y="456" width="40" height="112" rx="20" fill="#ffffff" opacity="0.95"/>
    <rect x="612" y="410" width="40" height="204" rx="20" fill="#ffffff" opacity="0.8"/>
    <rect x="668" y="472" width="40" height="80"  rx="20" fill="#ffffff" opacity="0.6"/>
  </g>
</svg>`

// Monochrome tray glyph (mac template = black + alpha; windows = colored)
const traySvg = (S, color) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 22 22">
  <path d="M3.5 5.2 L3.5 16.8 L12.4 11 Z" fill="${color}" stroke="${color}" stroke-width="1.6" stroke-linejoin="round"/>
  <rect x="14.2" y="8.2" width="2.2" height="5.6" rx="1.1" fill="${color}"/>
  <rect x="17.4" y="6" width="2.2" height="10" rx="1.1" fill="${color}"/>
</svg>`

let win = null
async function render(svg, size, file) {
  if (!win) win = new BrowserWindow({ show: false, width: 1024, height: 1024, transparent: true, frame: false, webPreferences: { offscreen: true } })
  win.setContentSize(size, size)
  const html = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`
  const tmp = path.join(require('os').tmpdir(), `yj-icon-${size}-${Date.now()}.html`)
  fs.writeFileSync(tmp, html)
  await win.loadFile(tmp)
  fs.unlinkSync(tmp)
  await new Promise((r) => setTimeout(r, 200))
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size })
  fs.writeFileSync(path.join(out, file), img.toPNG())
  console.log('wrote', file, `${size}px`)
}

app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, 'icon.svg'), appSvg(1024))
  await render(appSvg(1024), 1024, 'icon.png')
  await render(traySvg(22, '#000000'), 22, 'trayTemplate.png')
  await render(traySvg(44, '#000000'), 44, 'trayTemplate@2x.png')
  await render(traySvg(32, '#5457e0'), 32, 'tray.png')
  app.quit()
}).catch((e) => { console.error(e); app.exit(1) })
