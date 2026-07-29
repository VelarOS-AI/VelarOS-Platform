import { fileURLToPath, URL } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const componentLibraryRoot = fileURLToPath(new URL('.', import.meta.url))
const catalogSourceRoot = fileURLToPath(new URL('./src/componentLibrary', import.meta.url))
const conversationSourceRoot = fileURLToPath(
  new URL('../packages/conversation-ui/src', import.meta.url)
)
const uiSourceRoot = fileURLToPath(new URL('../packages/ui/src', import.meta.url))

export default defineConfig({
  root: componentLibraryRoot,
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: [
      {
        find: '@catalog',
        replacement: catalogSourceRoot,
      },
      {
        find: /^@velaros-ai\/conversation-ui$/,
        replacement: `${conversationSourceRoot}/index.ts`,
      },
      {
        find: /^@velaros-ai\/conversation-ui\/(.+)$/,
        replacement: `${conversationSourceRoot}/$1`,
      },
      {
        find: /^@velaros-ai\/ui$/,
        replacement: `${uiSourceRoot}/index.ts`,
      },
      {
        find: /^@velaros-ai\/ui\/(.+)$/,
        replacement: `${uiSourceRoot}/$1`,
      },
    ],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
