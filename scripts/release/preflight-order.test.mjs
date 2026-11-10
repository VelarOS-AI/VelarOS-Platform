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

async function publisherCalls() {
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
  const hasFlag = (call, flag) =>
    call.arguments[1].elements.some(
      (element) => ts.isStringLiteral(element) && element.text === flag
    )
  return { source, calls, named, releaseCall, hasFlag }
}

test('base archive consumption and its receipt guard precede upload and public release', async () => {
  const { calls, named, releaseCall } = await publisherCalls()
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

test('ordinary Platform pair consumption and persisted proof guard precede stable promotion', async () => {
  const { source, calls, named, releaseCall, hasFlag } = await publisherCalls()
  const candidate = calls.find(
    (call) =>
      releaseCall(call, 'edit') && hasFlag(call, '--draft=false') && hasFlag(call, '--prerelease')
  )
  const stable = calls.find(
    (call) =>
      releaseCall(call, 'edit') && hasFlag(call, '--prerelease=false') && hasFlag(call, '--latest')
  )
  const validation = calls.find((call) => named(call, 'validatePlatformRelease'))
  const uploaded = (name) =>
    calls.find(
      (call) =>
        releaseCall(call, 'upload') &&
        call.arguments[1].elements.some(
          (element) => ts.isIdentifier(element) && element.text === name
        )
    )
  const archive = uploaded('tarballPath')
  const receipt = uploaded('validationPath')
  const manifest = uploaded('manifestPath')
  assert(candidate && stable && validation && archive && receipt && manifest)
  assert(hasFlag(candidate, '--latest=false'))
  assert(
    !hasFlag(stable, '--draft=false'),
    'Candidate exposure must not stand in for stable promotion'
  )
  for (const publication of [candidate, stable]) {
    let branch = publication.parent
    while (branch && !ts.isIfStatement(branch)) branch = branch.parent
    assert(
      branch && ts.isIdentifier(branch.expression) && branch.expression.text === 'platformPair'
    )
  }
  assert(archive.pos < candidate.pos && candidate.pos < validation.pos)
  assert(validation.pos < receipt.pos && receipt.pos < manifest.pos && manifest.pos < stable.pos)

  const assignment = validation.parent.parent
  assert(ts.isAwaitExpression(validation.parent))
  assert(ts.isBinaryExpression(assignment))
  assert(ts.isPropertyAccessExpression(assignment.left))
  assert.equal(assignment.left.expression.getText(source), 'candidateReceipt')
  assert.equal(assignment.left.name.text, 'platformValidation')
  assert(
    calls.some(
      (call) =>
        named(call, 'saveCandidateReceipt') && validation.pos < call.pos && call.pos < receipt.pos
    )
  )
  const requiresPair = (call) =>
    named(call, 'assertCandidateReceipt') &&
    call.arguments.some(
      (argument) =>
        ts.isObjectLiteralExpression(argument) &&
        argument.properties.some(
          (property) =>
            ts.isPropertyAssignment(property) &&
            property.name.getText(source) === 'requirePlatformValidation' &&
            (property.initializer.kind === ts.SyntaxKind.TrueKeyword ||
              (ts.isIdentifier(property.initializer) &&
                property.initializer.text === 'platformPair'))
        )
    )
  assert(
    calls.some((call) => requiresPair(call) && validation.pos < call.pos && call.pos < receipt.pos)
  )
  assert(
    calls.some((call) => requiresPair(call) && manifest.pos < call.pos && call.pos < stable.pos)
  )
  assert(
    calls.some(
      (call) =>
        named(call, 'assertLocalIdentity') && manifest.pos < call.pos && call.pos < stable.pos
    )
  )
  assert(
    calls.some(
      (call) =>
        named(call, 'assert') &&
        ts.isIdentifier(call.arguments[0]) &&
        call.arguments[0].text === 'basePackage'
    ),
    'Capabilities cannot select publication without a base'
  )
  assert(
    calls.some((call) => {
      if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== 'equal')
        return false
      const [dependency, url] = call.arguments
      return (
        dependency &&
        ts.isElementAccessExpression(dependency) &&
        ts.isPropertyAccessExpression(dependency.expression) &&
        dependency.expression.name.text === 'dependencies' &&
        ts.isIdentifier(dependency.expression.expression) &&
        dependency.expression.expression.text === 'packedManifest' &&
        url &&
        ts.isPropertyAccessExpression(url) &&
        url.name.text === 'url' &&
        ts.isIdentifier(url.expression) &&
        url.expression.text === 'base'
      )
    }),
    'Packed capabilities must require the same ordinary canonical base URL'
  )

  const flags = new Set()
  let validationFlagGuard = false
  let receiptBytesGuard = false
  const guard = source.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find(
      (declaration) =>
        ts.isIdentifier(declaration.name) && declaration.name.text === 'assertCandidateReceipt'
    )
  assert(guard && ts.isArrowFunction(guard.initializer) && ts.isBlock(guard.initializer.body))
  const pairChecks = guard.initializer.body.statements.find(
    (statement) =>
      ts.isIfStatement(statement) &&
      ts.isIdentifier(statement.expression) &&
      statement.expression.text === 'requirePlatformValidation'
  )
  assert(pairChecks, 'Pair flags and persisted bytes must be part of the promotion guard')
  const visit = (node) => {
    if (ts.isForOfStatement(node) && ts.isArrayLiteralExpression(node.expression))
      for (const element of node.expression.elements)
        if (ts.isStringLiteral(element)) flags.add(element.text)
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const first = node.arguments[0]
      if (
        node.expression.name.text === 'equal' &&
        first &&
        ts.isElementAccessExpression(first) &&
        ts.isPropertyAccessExpression(first.expression) &&
        first.expression.name.text === 'validation' &&
        node.arguments[1]?.kind === ts.SyntaxKind.TrueKeyword
      )
        validationFlagGuard = true
      if (
        node.expression.name.text === 'deepEqual' &&
        first &&
        ts.isCallExpression(first) &&
        ts.isPropertyAccessExpression(first.expression) &&
        first.expression.name.text === 'parse' &&
        ts.isIdentifier(first.expression.expression) &&
        first.expression.expression.text === 'JSON'
      ) {
        const read = first.arguments[0]
        if (
          read &&
          ts.isAwaitExpression(read) &&
          ts.isCallExpression(read.expression) &&
          named(read.expression, 'readFile')
        ) {
          const receiptPath = read.expression.arguments[0]
          receiptBytesGuard = Boolean(
            receiptPath &&
            ts.isPropertyAccessExpression(receiptPath) &&
            receiptPath.name.text === 'receiptPath' &&
            ts.isPropertyAccessExpression(receiptPath.expression) &&
            receiptPath.expression.name.text === 'local' &&
            ts.isIdentifier(receiptPath.expression.expression) &&
            receiptPath.expression.expression.text === 'proof'
          )
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(pairChecks.thenStatement)
  for (const flag of [
    'ordinaryInstall',
    'frozenInstall',
    'sameBaseInstance',
    'strictDeclarations',
    'actualProjectMutation',
    'sourceIntegrity',
  ])
    assert(flags.has(flag), `Stable receipt must require ${flag}`)
  assert(
    validationFlagGuard && receiptBytesGuard,
    'Stable publication must reread the complete passing proof'
  )
})

test('Platform candidate failure restores draft and preserves a restoration failure', async () => {
  const { source, calls, releaseCall, hasFlag } = await publisherCalls()
  const restore = calls.find(
    (call) =>
      releaseCall(call, 'edit') &&
      hasFlag(call, '--draft=true') &&
      hasFlag(call, '--prerelease') &&
      hasFlag(call, '--latest=false')
  )
  assert(restore, 'Failed pair validation must attempt to hide the prerelease candidate')
  let cursor = restore.parent
  while (cursor && !ts.isCatchClause(cursor)) cursor = cursor.parent
  assert(cursor, 'Restoration belongs to the publication failure path')
  const aggregates = []
  const visit = (node) => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'AggregateError'
    )
      aggregates.push(node)
    ts.forEachChild(node, visit)
  }
  visit(cursor)
  assert(
    aggregates.some((node) => {
      const errors = node.arguments?.[0]
      return (
        errors &&
        ts.isArrayLiteralExpression(errors) &&
        errors.elements.map((element) => element.getText(source)).join(',') === 'error,restoreError'
      )
    }),
    'The primary and restoration errors must both survive'
  )
})
