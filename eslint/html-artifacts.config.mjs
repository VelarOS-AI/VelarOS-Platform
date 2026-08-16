// ESLint configuration for HTML Artifacts. Source and build scripts use the shared
// Platform baseline; generated output, demos, and retired fixtures are excluded.
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createDomainConfig } from './_shared.config.mjs'

const rootDir = dirname(fileURLToPath(import.meta.url))

export default createDomainConfig({
  rootDir,
  ignores: [
    'packages/html-artifacts/demo/**',
    'packages/html-artifacts/tests/**',
    'packages/html-artifacts/dist/**',
    'packages/html-artifacts/demo-dist/**',
  ],
})
