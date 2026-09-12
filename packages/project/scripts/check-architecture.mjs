#!/usr/bin/env node
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs'
import {
  dirname,
  extname,
  relative,
  resolve,
} from 'node:path'

import * as ts from 'typescript'

const RepoRoot = resolve(import.meta.dirname, '..')
const WorkspaceRoot = resolve(RepoRoot, '../..')
const ManifestPath = resolve(RepoRoot, 'package.json')
const TsconfigPath = resolve(RepoRoot, 'tsconfig.json')
const SourceRoot = resolve(RepoRoot, 'src')
const SourceExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs'])
const ForbiddenHostImport =
  /(?:from\s+|import\s*\(|require\()\s*['"](?:electron(?:\/[^'"]*)?|@electron\/[^'"]*|@velaros\/ipc(?:\/[^'"]*)?|@(?:components|features|hooks|pages|styles|shared)\/[^'"]*|@\/[^'"]*|@preload|@main\/[^'"]*)['"]/
const ForbiddenCapabilityImport =
  /(?:from\s+|import\s*\(|require\()\s*['"]@velaros-ai\/(?:browser|memory|computer|system|development|office)(?:\/[^'"]*)?['"]/
const ForbiddenKernelSemanticImport =
  /(?:from\s+|import\s*\(|require\()\s*['"](?:@velaros-ai\/agent|@velaros-ai\/core\/(?:constants\/(?:project[^'"]*|model[^'"]*|memory[^'"]*|knowledge[^'"]*)|spaces\/[^'"]*|utils\/Browser[^'"]*))['"]/
const CoreTypesImport =
  /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]@velaros-ai\/core\/types['"]/g
const ConcreteCoreTypeName =
  /\b(?:Browser|Project|Workbench|Model|Memory|Knowledge)[A-Z_a-z0-9]*/

const manifest = JSON.parse(readFileSync(ManifestPath, 'utf8'))
const rootManifest = JSON.parse(readFileSync(resolve(WorkspaceRoot, 'package.json'), 'utf8'))
const failures = []
const fail = (message) => failures.push(message)

const TransactionObjectNames = new Set(['tx', 'transaction', 'preparedTx'])

function hasUnmanagedTransactionStatusAssignment(source, path) {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const stateMachineResults = new Set()
  const collectStateMachineResults = (node) => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer?.getText(sourceFile).includes('transactionStateMachine.')
    ) {
      stateMachineResults.add(node.name.text)
    }
    ts.forEachChild(node, collectStateMachineResults)
  }
  collectStateMachineResults(sourceFile)

  let unmanaged = false
  const visit = (node) => {
    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(node.left)
      && node.left.name.text === 'status'
      && ts.isIdentifier(node.left.expression)
      && TransactionObjectNames.has(node.left.expression.text)
    ) {
      const right = node.right.getText(sourceFile)
      if (!right.includes('transactionStateMachine.') && !stateMachineResults.has(right)) {
        unmanaged = true
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return unmanaged
}

function validationContextViolations(source, path, sourcePath) {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const declarationName = (node) => node.name && ts.isIdentifier(node.name)
    ? node.name.text
    : undefined
  const objectMemberName = (member) => declarationName(member)
  const validatorObjects = []
  const collectValidatorObjects = (node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const names = new Set(node.properties.map(objectMemberName).filter(Boolean))
      if (names.has('id') && names.has('canValidate') && names.has('validate')) {
        validatorObjects.push(node)
      }
    }
    ts.forEachChild(node, collectValidatorObjects)
  }
  collectValidatorObjects(sourceFile)

  const participatesInValidationContract = sourcePath === 'types/validation.ts'
    || validatorObjects.length > 0
    || /\bProjectValidator\b|\bProjectValidationContext\b|\bregisterValidator\s*\(/.test(source)
  if (!participatesInValidationContract) return []

  const violations = []
  let projectValidatorContextType
  let hasProjectValidationContext = false
  const validateParameters = (node) => {
    const name = declarationName(node)
    if (
      name === 'validate'
      && (ts.isMethodDeclaration(node) || ts.isMethodSignature(node))
    ) return node.parameters
    if (
      name === 'validate'
      && ts.isPropertyAssignment(node)
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) return node.initializer.parameters
    if (
      name === 'validate'
      && ts.isPropertySignature(node)
      && node.type
      && ts.isFunctionTypeNode(node.type)
    ) return node.type.parameters
    return undefined
  }

  const isProjectValidatorType = (type) => type?.getText(sourceFile) === 'ProjectValidator'
  const hasProjectValidatorContext = (object) => {
    let current = object.parent
    while (current && !ts.isSourceFile(current)) {
      if (ts.isVariableDeclaration(current) && isProjectValidatorType(current.type)) return true
      if (
        (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) || ts.isArrowFunction(current))
        && isProjectValidatorType(current.type)
      ) return true
      if (
        ts.isCallExpression(current)
        && current.expression.getText(sourceFile).endsWith('registerValidator')
      ) return true
      if (
        (ts.isAsExpression(current) || ts.isSatisfiesExpression(current))
        && isProjectValidatorType(current.type)
      ) return true
      current = current.parent
    }
    return false
  }

  const visit = (node) => {
    const name = declarationName(node)
    if (
      name
      && /(?:Validation|Validator)Context/.test(name)
      && name !== 'ProjectValidationContext'
      && (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node))
    ) {
      violations.push(`duplicate validator context declaration ${name}`)
    }
    if (name === 'ProjectValidationContext') hasProjectValidationContext = true

    if (
      sourcePath === 'types/validation.ts'
      && ts.isInterfaceDeclaration(node)
      && name === 'ProjectValidator'
    ) {
      const validateMember = node.members.find((member) => declarationName(member) === 'validate')
      const declaredContextType = validateMember && ts.isMethodSignature(validateMember)
        ? validateMember.parameters[1]?.type
        : undefined
      projectValidatorContextType = declaredContextType?.getText(sourceFile)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  for (const object of validatorObjects) {
    const validateMember = object.properties.find((member) => objectMemberName(member) === 'validate')
    const contextParameter = validateMember ? validateParameters(validateMember)?.[1] : undefined
    const contextType = contextParameter?.type?.getText(sourceFile)
    if (contextType && contextType !== 'ProjectValidationContext') {
      violations.push(`validator validate context must use ProjectValidationContext, got ${contextType}`)
    } else if (!contextType && !hasProjectValidatorContext(object)) {
      violations.push('structural ProjectValidator validate context must explicitly use ProjectValidationContext')
    }
  }

  if (sourcePath === 'types/validation.ts') {
    if (!hasProjectValidationContext) violations.push('ProjectValidationContext declaration is required')
    if (projectValidatorContextType !== 'ProjectValidationContext') {
      violations.push('ProjectValidator.validate must use ProjectValidationContext')
    }
  }
  return violations
}

function registeredValidatorContextViolations() {
  const configFile = ts.readConfigFile(TsconfigPath, ts.sys.readFile)
  if (configFile.error)
    return [`cannot read Project tsconfig: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n')}`]
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, RepoRoot)
  const program = ts.createProgram(parsed.fileNames, parsed.options)
  const checker = program.getTypeChecker()
  const validationSource = program.getSourceFile(resolve(SourceRoot, 'types/validation.ts'))
  const contextDeclaration = validationSource?.statements.find((statement) =>
    ts.isInterfaceDeclaration(statement) && statement.name.text === 'ProjectValidationContext'
  )
  if (!contextDeclaration) return ['ProjectValidationContext declaration is required']
  const canonicalContextType = checker.getTypeAtLocation(contextDeclaration)
  const violations = []

  const visit = (sourceFile, node) => {
    if (
      ts.isCallExpression(node)
      && node.arguments[0]
      && node.expression.getText(sourceFile).endsWith('registerValidator')
    ) {
      const validatorType = checker.getTypeAtLocation(node.arguments[0])
      const validate = checker.getPropertyOfType(validatorType, 'validate')
      const validateType = validate
        ? checker.getTypeOfSymbolAtLocation(validate, node.arguments[0])
        : undefined
      const signature = validateType
        ? checker.getSignaturesOfType(validateType, ts.SignatureKind.Call)[0]
        : undefined
      const contextParameter = signature?.getParameters()[1]
      const contextType = contextParameter
        ? checker.getTypeOfSymbolAtLocation(
            contextParameter,
            contextParameter.valueDeclaration ?? node.arguments[0],
          )
        : undefined
      if (contextType !== canonicalContextType) {
        const actual = contextType ? checker.typeToString(contextType) : 'missing'
        violations.push(
          `registered validator validate context must resolve to ProjectValidationContext, got ${actual} in ${relative(RepoRoot, sourceFile.fileName)}`,
        )
      }
    }
    ts.forEachChild(node, (child) => visit(sourceFile, child))
  }

  for (const sourceFile of program.getSourceFiles()) {
    if (!sourceFile.fileName.startsWith(SourceRoot) || sourceFile.isDeclarationFile) continue
    visit(sourceFile, sourceFile)
  }
  return violations
}

const ForbiddenInternalDependencies = [
  {
    source: (sourcePath) => sourcePath.startsWith('types/'),
    targets: ['core/', 'agent/', 'composition/', 'infrastructure/'],
    label: 'types must not depend on core, Agent, composition, or infrastructure',
  },
  {
    source: (sourcePath) => sourcePath.startsWith('core/'),
    targets: ['agent/'],
    label: 'core must not depend on Agent adapters',
  },
  {
    source: (sourcePath) => sourcePath.startsWith('agent/'),
    targets: ['core/project-kernel'],
    label: 'Agent adapters must not depend on the ProjectKernel implementation',
  },
  {
    source: (sourcePath) => sourcePath === 'transaction-state.ts',
    targets: ['core/project-kernel'],
    label: 'transaction-state must depend on transaction domain types, not ProjectKernel',
  },
  {
    source: (sourcePath) => sourcePath === 'core/transaction-repository.ts',
    targets: ['core/project-kernel'],
    label: 'transaction repository must not depend on ProjectKernel',
  },
  {
    source: (sourcePath) => sourcePath === 'core/transaction-projection-repository.ts',
    targets: ['core/project-kernel'],
    label: 'transaction projection repository must not depend on ProjectKernel',
  },
  {
    source: (sourcePath) => sourcePath === 'core/transaction-overlay.ts',
    targets: ['core/', 'registry/', 'transaction-state'],
    label: 'transaction overlay must depend only on domain types and injected callbacks',
  },
  {
    source: (sourcePath) => sourcePath === 'core/transaction-validation.ts',
    targets: [
      'core/defaults',
      'core/file-store',
      'core/lock-manager',
      'core/project-kernel',
      'core/transaction-coordinator',
      'core/transaction-projection-repository',
      'core/transaction-repository',
      'core/transaction-state-machine',
      'registry/',
      'transaction-state',
    ],
    label: 'transaction validation must use domain types, TransactionOverlay views, and injected callbacks',
  },
]

if (manifest.name !== '@velaros-ai/project') {
  fail(`package name must be @velaros-ai/project, got ${manifest.name}`)
}
// 断言「版本单源」而不是钉死某个字面量版本号：`PROJECT_PACKAGE_VERSION` 会被写进 kernel
// module manifest 与全部内置插件的 version 字段，与 package.json 漂移时，宿主看到的是一个
// 不存在的版本。钉字面量的旧写法让这条门在每次正常升版时变红（实测已卡在 1.2.3 而包已到
// 1.2.5），红成常态的门等于没有门。
const versionConstantSource = readFileSync(resolve(SourceRoot, 'core/defaults.ts'), 'utf8')
const versionConstant = /PROJECT_PACKAGE_VERSION\s*=\s*["']([^"']+)["']/.exec(versionConstantSource)?.[1]
if (versionConstant !== manifest.version) {
  fail(
    `PROJECT_PACKAGE_VERSION (${versionConstant ?? 'not found'}) must match package.json version (${manifest.version})`,
  )
}
if (manifest.repository?.url !== rootManifest.repository?.url) {
  fail('repository URL must point to VelarOS-Platform')
}
if (manifest.repository?.directory !== 'packages/project') {
  fail('repository.directory must be packages/project')
}
if (
  manifest.exports?.['./agent']?.import !== './dist/agent/index.js'
  || manifest.exports?.['./agent']?.types !== './dist/agent/index.d.ts'
) {
  fail('@velaros-ai/project/agent must expose the integrated Agent adapter')
}
if (manifest.peerDependencies?.['@velaros-ai/agent'] !== 'workspace:^') {
  fail('@velaros-ai/project must use the host-owned @velaros-ai/agent peer')
}
if (
  manifest.publishConfig?.access !== 'public'
  || manifest.publishConfig?.registry !== 'https://npm.pkg.github.com'
) {
  fail('publishConfig must target public GitHub Packages')
}

for (const path of walk(RepoRoot)) {
  if (path !== ManifestPath && path.endsWith('/package.json')) {
    fail(`Project package must not contain nested packages; found ${relative(RepoRoot, path)}`)
  }
}

for (const path of walk(SourceRoot)) {
  if (!SourceExtensions.has(extname(path))) continue
  const source = readFileSync(path, 'utf8')
  if (ForbiddenHostImport.test(source)) {
    fail(`host import in ${relative(RepoRoot, path)}`)
  }
  if (ForbiddenCapabilityImport.test(source)) {
    fail(`concrete capability import in ${relative(RepoRoot, path)}`)
  }
  if (ForbiddenKernelSemanticImport.test(source)) {
    fail(`concrete Kernel semantic import in ${relative(RepoRoot, path)}`)
  }
  for (const match of source.matchAll(CoreTypesImport)) {
    if (ConcreteCoreTypeName.test(match[1])) {
      fail(`concrete Core type import in ${relative(RepoRoot, path)}`)
    }
  }
  const sourcePath = relative(SourceRoot, path).replaceAll('\\', '/')
  for (const violation of validationContextViolations(source, path, sourcePath)) {
    fail(`${violation} in ${sourcePath}`)
  }
  if (sourcePath === 'core/project-kernel.ts' && hasUnmanagedTransactionStatusAssignment(source, path)) {
    fail('ProjectKernel transaction status changes must go through TransactionStateMachine')
  }
  const importedSpecifiers = ts.preProcessFile(source, true, true).importedFiles
    .map((reference) => reference.fileName)
  for (const rule of ForbiddenInternalDependencies) {
    if (!rule.source(sourcePath)) continue
    for (const specifier of importedSpecifiers) {
      if (!specifier.startsWith('.')) continue
      const targetPath = relative(SourceRoot, resolve(SourceRoot, dirname(sourcePath), specifier))
        .replaceAll('\\', '/')
        .replace(/\.js$/, '')
      if (rule.targets.some((target) => targetPath.startsWith(target))) {
        fail(`${rule.label} in ${sourcePath}: ${specifier}`)
      }
    }
  }
}

for (const violation of registeredValidatorContextViolations()) fail(violation)

if (failures.length > 0) {
  console.error(`Project architecture check failed (${failures.length}):`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.info('✓ one standalone @velaros-ai/project package')
console.info('✓ Project-owned Agent adapter contracts and host/capability boundaries')
console.info('✓ Project internal type, core, Agent, and transaction-state dependency directions')
console.info('✓ ProjectKernel transaction lifecycle changes go through TransactionStateMachine')
console.info('✓ Project validators share one typed validation context contract')

function walk(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory).flatMap((entry) => {
    if (entry === '.git' || entry === 'node_modules' || entry === 'dist') return []
    const path = resolve(directory, entry)
    const stats = statSync(path)
    return stats.isDirectory() ? walk(path) : [path]
  })
}
