// ESLint configuration for the Memory domain.
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createDomainConfig } from './_shared.config.mjs'

const rootDir = dirname(fileURLToPath(import.meta.url))

export default createDomainConfig({
  rootDir,
  ignores: ['tests/**'],
  // Memory keeps this stricter local rule in addition to the shared baseline.
  tsRules: { '@typescript-eslint/prefer-as-const': 'error' },
})
