import { expect, test } from 'bun:test'

import { typescriptSyntaxValidator } from '../src/plugins/typescript/validators'
import { ValidatorRegistry } from '../src/registry/validator-registry'
import type { ProjectValidationContext } from '../src/types/validation'

function fixture() {
  const files = new Map([
    ['a.ts', 'const a = 1'],
    ['docs.md', 'old'],
  ])
  const context = {
    root: '/repo',
    readFile: async (path: string) => files.get(path),
    getTransaction: () => undefined,
  } as unknown as ProjectValidationContext
  return { files, context }
}

test('syntax evidence survives unrelated changes, invalidates source changes and returns isolated results', async () => {
  const { files, context } = fixture()
  const registry = new ValidatorRegistry()
  const validator = typescriptSyntaxValidator()
  let runs = 0
  const validate = validator.validate
  validator.validate = (input, ctx) => {
    runs++
    return validate(input, ctx)
  }
  registry.register(validator)
  const input = { paths: ['a.ts'], checks: ['syntax'] }
  const first = await registry.validate(input, context)
  files.set('docs.md', 'new')
  const reused = await registry.validate(input, context)
  expect(runs).toBe(1)
  expect(reused.checks[0]!.metadata.reused).toBe(true)
  expect(reused.checks[0]!.metadata.evidenceKey).toBe(first.checks[0]!.metadata.evidenceKey)
  reused.diagnostics.push({ severity: 'error', message: 'mutated consumer' })
  expect((await registry.validate(input, context)).ok).toBe(true)
  files.set('a.ts', 'const a = ;')
  expect((await registry.validate(input, context)).ok).toBe(false)
  expect(runs).toBe(2)
  expect((await registry.validate(input, context)).ok).toBe(false)
  expect(runs).toBe(3)
})

test('a failed check without diagnostics is still failure and unknown dependencies never reuse', async () => {
  const { context } = fixture()
  const registry = new ValidatorRegistry()
  let runs = 0
  registry.register({
    id: 'external',
    canValidate: () => true,
    validate: () => {
      runs++
      return { ok: false, checks: [], diagnostics: [] }
    },
  })
  expect((await registry.validate({}, context)).ok).toBe(false)
  expect((await registry.validate({}, context)).ok).toBe(false)
  expect(runs).toBe(2)
})
