import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

const aliases = {
  '@core': resolve('src/core'),
  '@shared': resolve('src/shared'),
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: aliases },
    build: {
      rollupOptions: {
        // thumbnail-cli: standalone entry for the thumbnail plugin (renders a job file without the app)
        input: { index: resolve('src/main/index.ts'), 'thumbnail-cli': resolve('src/plugins/thumbnail/cli.ts') },
        // Keep shared chunks flat in out/main/: the thumbnail plugin resolves its template two
        // levels up from its own bundle directory (dev) — a chunks/ subfolder would land it in out/.
        output: { format: 'es', chunkFileNames: '[name]-[hash].js' },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } },
  },
  renderer: {
    resolve: { alias: { ...aliases, '@': resolve('src/renderer/src') } },
    plugins: [react(), tailwindcss()],
  },
})
