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
        // thumbnail-cli / audio-cli: standalone entries for the plugins (run without the app)
        input: { index: resolve('src/main/index.ts'), 'thumbnail-cli': resolve('src/plugins/thumbnail/cli.ts'), 'audio-cli': resolve('src/plugins/audio/cli.ts') },
        output: { format: 'es' },
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
