import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import ts from 'typescript'

const { scripts } = JSON.parse(
  await readFile(new URL('../../package.json', import.meta.url), 'utf8')
)

test('default and release checks use the bounded fast gate', () => {
  assert.equal(scripts.check, 'node scripts/quality/run-fast-check.mjs')
  assert.equal(scripts['check:fast'], scripts.check)
  assert.equal(scripts['release:check'], 'bun run check')
  assert.match(scripts['check:full'], /test:built/u)
  assert.match(scripts['check:full'], /check:gates:remaining/u)
})

test('base archive consumption and its receipt guard precede upload and public release', async () => {
  const source = ts.createSourceFile(
    'publish-packages.mjs',
    await readFile(new URL('./publish-packages.mjs', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  )
  const calls = []
  const visit = (node) => {
    if (ts.isCallExpression(node)) calls.push(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  const named = (call, name) => ts.isIdentifier(call.expression) && call.expression.text === name
  const releaseCall = (call, action) => {
    const [command, args] = call.arguments
    return (
      named(call, 'run') &&
      command &&
      ts.isStringLiteral(command) &&
      command.text === 'gh' &&
      args &&
      ts.isArrayLiteralExpression(args) &&
      args.elements.length >= 2 &&
      ts.isStringLiteral(args.elements[0]) &&
      args.elements[0].text === 'release' &&
      ts.isStringLiteral(args.elements[1]) &&
      args.elements[1].text === action
    )
  }
  const validation = calls.find((call) => named(call, 'validateSessionTraceArchive'))
  const upload = calls.find(
    (call) =>
      releaseCall(call, 'upload') &&
      call.arguments[1].elements.some(
        (element) => ts.isIdentifier(element) && element.text === 'tarballPath'
      )
  )
  const publication = calls.find(
    (call) =>
      releaseCall(call, 'edit') &&
      call.arguments[1].elements.some(
        (element) => ts.isStringLiteral(element) && element.text === '--draft=false'
      )
  )
  assert(
    validation && upload && publication,
    'Release must consume the base archive, upload bytes, then publish'
  )
  assert(validation.pos < upload.pos && upload.pos < publication.pos)
  const receiptGuards = calls.filter((call) => named(call, 'assertCandidateReceipt'))
  assert(receiptGuards.some((call) => call.pos > validation.pos && call.pos < upload.pos))
  assert(receiptGuards.some((call) => call.pos > upload.pos && call.pos < publication.pos))
})
