import { fileURLToPath, URL } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const componentLibraryRoot = fileURLToPath(new URL('.', import.meta.url))
const catalogSourceRoot = fileURLToPath(new URL('./src/componentLibrary', import.meta.url))
const conversationSourceRoot = fileURLToPath(
  new URL('../packages/ui/src/conversation', import.meta.url)
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
      // conversation 切片的别名必须排在 @velaros-ai/ui/* 之前:后者的通配会先吃掉
      // `@velaros-ai/ui/conversation/...`(虽然落点相同,但显式在前才不依赖巧合)。
      {
        find: /^@velaros-ai\/ui\/conversation$/,
        replacement: `${conversationSourceRoot}/index.ts`,
      },
      {
        find: /^@velaros-ai\/ui\/conversation\/(.+)$/,
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
