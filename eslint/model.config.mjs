// ESLint configuration for the Model domain. The recommended TypeScript rules extend
// the shared Platform baseline; local overrides below prevent duplicate diagnostics.
import tsPlugin from '@typescript-eslint/eslint-plugin'

import { createDomainConfig } from './_shared.config.mjs'

export default createDomainConfig({
  rootDir: import.meta.dirname,
  // Add recommended TypeScript rules that are not already part of the shared baseline.
  tsRulesBase: tsPlugin.configs.recommended.rules,
  // unused-imports/no-unused-vars is the single owner for unused-variable diagnostics.
  tsRules: { '@typescript-eslint/no-unused-vars': 'off' },
  declarationRules: {
    '@typescript-eslint/triple-slash-reference': 'off',
    '@typescript-eslint/no-unused-vars': 'off',
  },
})
