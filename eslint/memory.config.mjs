import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import js from '@eslint/js'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import prettierConfig from 'eslint-config-prettier'
import eslintComments from 'eslint-plugin-eslint-comments'
import simpleImportSort from 'eslint-plugin-simple-import-sort'
import unicorn from 'eslint-plugin-unicorn'
import unusedImports from 'eslint-plugin-unused-imports'
import globals from 'globals'

const rootDir = dirname(fileURLToPath(import.meta.url))
const commonGlobals = {
  ...globals.browser,
  ...globals.node,
  ...globals.es2024,
}
const commonPlugins = {
  'eslint-comments': eslintComments,
  'simple-import-sort': simpleImportSort,
  unicorn,
  'unused-imports': unusedImports,
}
const commonRules = {
  'array-callback-return': 'error',
  'arrow-body-style': ['error', 'as-needed'],
  curly: ['error', 'multi-line', 'consistent'],
  'default-case-last': 'error',
  'dot-notation': 'off',
  eqeqeq: ['error', 'smart'],
  'eslint-comments/no-unused-disable': 'error',
  'eslint-comments/require-description': [
    'error',
    { ignore: ['eslint-enable'] },
  ],
  'no-array-constructor': 'error',
  'no-console': ['error', { allow: ['warn', 'error', 'info'] }],
  'no-else-return': ['error', { allowElseIf: false }],
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-nested-ternary': 'off',
  'no-param-reassign': ['error', { props: false }],
  'no-return-await': 'error',
  'no-var': 'error',
  'object-shorthand': ['error', 'always'],
  'prefer-const': ['error', { destructuring: 'all' }],
  'simple-import-sort/exports': 'error',
  'simple-import-sort/imports': [
    'error',
    {
      groups: [
        ['^\\u0000@shared/extensions$', '^\\u0000@velaros-ai/core/extensions$'],
        ['^\\u0000dotenv/'],
        ['^\\u0000'],
        ['^node:'],
        ['^react$', '^react-dom', '^@?\\w'],
        ['^@velaros-ai/'],
        [
          '^@shared/',
          '^@components/',
          '^@features/',
          '^@hooks/',
          '^@pages/',
          '^@styles/',
          '^@utils/',
          '^@/',
        ],
        ['^\\.\\.(?!/?$)', '^\\.\\./?$'],
        ['^\\./(?=.*/)(?!/?$)', '^\\.(?!/?$)', '^\\./?$'],
        ['^.+\\.s?css$'],
      ],
    },
  ],
  'unicorn/consistent-function-scoping': 'off',
  'unicorn/explicit-length-check': 'off',
  'unicorn/no-array-for-each': 'off',
  'unicorn/no-await-expression-member': 'off',
  'unicorn/no-for-loop': 'off',
  'unicorn/no-negated-condition': 'off',
  'unicorn/prefer-array-flat-map': 'error',
  'unicorn/prefer-at': 'off',
  'unicorn/prefer-code-point': 'off',
  'unicorn/prefer-node-protocol': 'error',
  'unicorn/prefer-number-properties': 'off',
  'unicorn/prefer-string-replace-all': 'off',
  'unused-imports/no-unused-imports': 'error',
}

export default [
  {
    ignores: [
      '**/.git/**',
      '**/dist/**',
      '**/node_modules/**',
      'scripts/**',
      'tests/**',
      'bun.lock',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: commonGlobals,
      sourceType: 'module',
    },
    plugins: commonPlugins,
    rules: {
      ...commonRules,
      'no-undef': 'error',
      'unicorn/prefer-module': 'off',
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: commonGlobals,
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: rootDir,
      },
      sourceType: 'module',
    },
    plugins: {
      ...commonPlugins,
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...commonRules,
      'no-undef': 'off',
      'no-array-constructor': 'off',
      'no-return-await': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/array-type': [
        'error',
        { default: 'array-simple' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          disallowTypeAnnotations: false,
          fixStyle: 'inline-type-imports',
          prefer: 'type-imports',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/prefer-as-const': 'error',
    },
  },
  prettierConfig,
]
