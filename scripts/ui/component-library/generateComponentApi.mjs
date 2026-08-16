// 用途：从组件库 registry 生成公开组件 API 清单。
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, extname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = findProjectRoot(SCRIPT_DIR)
const TSCONFIG_PATH = resolve(ROOT_DIR, 'packages/ui/tsconfig.json')
const OUTPUT_PATH = resolve(
  ROOT_DIR,
  'component-library/src/componentLibrary/generated/componentApi.generated.ts'
)
const COMPONENT_LIBRARY_DIR = resolve(ROOT_DIR, 'component-library/src/componentLibrary')
const UI_PACKAGE_SOURCE = realpathSync(resolve(ROOT_DIR, 'packages/ui/src'))
const PUBLIC_INDEX_FILES = [resolve(UI_PACKAGE_SOURCE, 'index.ts')]
const EXTRA_PUBLIC_COMPONENT_NAMES = new Set()
const SCAN_ROOTS = [UI_PACKAGE_SOURCE]
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx'])
const INTERNAL_PROP_DESCRIPTION = 'Auto-generated from TypeScript props.'
const HIDDEN_PROPS = new Set([
  'aria-label',
  'children',
  'className',
  'key',
  'ref',
  'style',
])

function findProjectRoot(startDir) {
  let currentDir = startDir

  while (true) {
    if (
      existsSync(resolve(currentDir, 'package.json')) &&
      existsSync(resolve(currentDir, 'packages/ui/src'))
    ) {
      return currentDir
    }

    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) {
      throw new Error(`Unable to locate project root from ${startDir}`)
    }

    currentDir = parentDir
  }
}

function normalizePath(filePath) {
  return filePath.split(sep).join('/')
}

function isInsideDirectory(filePath, directoryPath) {
  const normalizedFile = normalizePath(filePath)
  const normalizedDirectory = normalizePath(directoryPath)

  return (
    normalizedFile === normalizedDirectory || normalizedFile.startsWith(`${normalizedDirectory}/`)
  )
}

function collectSourceFiles(dir) {
  const entries = readdirSync(dir)
  const files = []

  for (const entry of entries) {
    const fullPath = resolve(dir, entry)
    const stats = statSync(fullPath)

    if (stats.isDirectory()) {
      files.push(...collectSourceFiles(fullPath))
      continue
    }

    if (SOURCE_EXTENSIONS.has(extname(fullPath))) {
      files.push(fullPath)
    }
  }

  return files
}

function readProgram() {
  const config = ts.readConfigFile(TSCONFIG_PATH, ts.sys.readFile)
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  }

  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    dirname(TSCONFIG_PATH)
  )
  const analysisOptions = {
    ...parsed.options,
    paths: {
      ...parsed.options.paths,
      '@velaros-ai/ui': ['packages/ui/src/index.ts'],
      '@velaros-ai/ui/*': ['packages/ui/src/*'],
    },
  }
  const program = ts.createProgram(
    [...parsed.fileNames, ...SCAN_ROOTS.flatMap(collectSourceFiles)],
    analysisOptions
  )

  return { program, checker: program.getTypeChecker() }
}

function getStringLiteralText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return `'${node.text}'`
  }

  return node.getText()
}

function getDefaultVariantValues(sourceFile) {
  const defaults = new Map()

  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'cva'
    ) {
      const options = node.arguments.find(ts.isObjectLiteralExpression)
      const defaultVariants = options?.properties.find(
        (property) =>
          ts.isPropertyAssignment(property) &&
          ts.isIdentifier(property.name) &&
          property.name.text === 'defaultVariants' &&
          ts.isObjectLiteralExpression(property.initializer)
      )

      if (defaultVariants && ts.isPropertyAssignment(defaultVariants)) {
        for (const property of defaultVariants.initializer.properties) {
          if (
            ts.isPropertyAssignment(property) &&
            (ts.isIdentifier(property.name) ||
              ts.isStringLiteral(property.name) ||
              ts.isNoSubstitutionTemplateLiteral(property.name))
          ) {
            defaults.set(property.name.text, getStringLiteralText(property.initializer))
          }
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)

  return defaults
}

function collectBindingDefaults(bindingName, binding, defaults) {
  if (!ts.isObjectBindingPattern(binding)) {
    return
  }

  for (const element of binding.elements) {
    if (ts.isIdentifier(element.name) && element.initializer) {
      defaults.set(element.name.text, getStringLiteralText(element.initializer))
      continue
    }

    if (bindingName && ts.isObjectBindingPattern(element.name)) {
      collectBindingDefaults(bindingName, element.name, defaults)
    }
  }
}

function collectFunctionDefaults(functionLike, defaults) {
  const firstParam = functionLike.parameters[0]
  if (firstParam?.name) {
    collectBindingDefaults(undefined, firstParam.name, defaults)
  }
}

function collectComponentDefaults(sourceFile, componentName) {
  const defaults = getDefaultVariantValues(sourceFile)

  function collectFromExpression(expression) {
    function visit(node) {
      if (
        (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) &&
        (!node.name || node.name.text === componentName || node.name.text === `${componentName}Inner`)
      ) {
        collectFunctionDefaults(node, defaults)
      }

      ts.forEachChild(node, visit)
    }

    visit(expression)
  }

  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === componentName) {
      collectFunctionDefaults(node, defaults)
    }

    if (ts.isFunctionExpression(node) && node.name?.text === componentName) {
      collectFunctionDefaults(node, defaults)
    }

    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      (node.name.text === componentName || node.name.text === `${componentName}Inner`) &&
      node.initializer
    ) {
      collectFromExpression(node.initializer)
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)

  return defaults
}

function getDocumentation(checker, prop) {
  const text = ts
    .displayPartsToString(prop.getDocumentationComment(checker))
    .replace(/\r\n?/g, '\n')
    .trim()

  return text || INTERNAL_PROP_DESCRIPTION
}

function hasUndefined(type) {
  if (type.isUnion()) {
    return type.types.some((entry) => (entry.flags & ts.TypeFlags.Undefined) !== 0)
  }

  return false
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function cleanTypeText(typeText) {
  const publicUiIndex = normalizePath(PUBLIC_INDEX_FILES[0]).replace(/\.ts$/, '')
  const cleaned = typeText
    .replace(
      /import\("[^"]*\/node_modules\/(?:\.bun\/[^/]+\/node_modules\/)?@types\/react\/index"\)\./g,
      'React.',
    )
    .replace(
      new RegExp(`import\\("${escapeRegularExpression(publicUiIndex)}"\\)`, 'g'),
      'import("@velaros-ai/ui")',
    )
    .replace(/\s*\|\s*undefined/g, '')
    .replace(/undefined\s*\|\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (/import\("(?:\/|[A-Za-z]:\\\\)/.test(cleaned)) {
    throw new Error(`Generated component API type contains an absolute import: ${cleaned}`)
  }

  return cleaned
}

function isLocalDeclaration(declaration) {
  if (!declaration) {
    return false
  }

  return SCAN_ROOTS.some((root) => isInsideDirectory(declaration.getSourceFile().fileName, root))
}

function getPropRows(program, checker, sourceFile, declaration, componentName) {
  const type = checker.getTypeAtLocation(declaration.name)
  const defaults = collectComponentDefaults(sourceFile, componentName)
  const rows = []

  for (const prop of checker.getPropertiesOfType(type)) {
    if (HIDDEN_PROPS.has(prop.name) || prop.name.startsWith('aria-') || prop.name.startsWith('data-')) {
      continue
    }

    const propDeclaration = prop.valueDeclaration ?? prop.declarations?.[0]
    if (!isLocalDeclaration(propDeclaration)) {
      continue
    }

    const propType = checker.getTypeOfSymbolAtLocation(prop, propDeclaration ?? declaration)
    const required = !hasUndefined(propType) && !defaults.has(prop.name)
    const defaultValue = defaults.get(prop.name)
    const row = {
      name: `${componentName}.${prop.name}`,
      description: getDocumentation(checker, prop),
      type: cleanTypeText(
        checker.typeToString(
          propType,
          propDeclaration ?? declaration,
          ts.TypeFormatFlags.NoTruncation |
            ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope
        )
      ),
    }

    if (defaultValue !== undefined) {
      row.defaultValue = defaultValue
    }

    if (required) {
      row.recommended = 'Required'
    }

    rows.push(row)
  }

  return rows
}

function collectPropsDeclarations(program, checker) {
  const scanFiles = new Set(
    SCAN_ROOTS.flatMap(collectSourceFiles).map((filePath) => normalizePath(filePath))
  )
  const components = new Map()

  for (const sourceFile of program.getSourceFiles()) {
    if (!scanFiles.has(normalizePath(sourceFile.fileName))) {
      continue
    }

    function visit(node) {
      const isPropsDeclaration =
        (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
        node.name.text.endsWith('Props')

      if (isPropsDeclaration) {
        const componentName = node.name.text.replace(/Props$/, '')
        const rows = getPropRows(program, checker, sourceFile, node, componentName)

        if (rows.length) {
          components.set(componentName, rows)
        }
      }

      ts.forEachChild(node, visit)
    }

    visit(sourceFile)
  }

  return [...components.entries()].sort(([left], [right]) => {
    if (left === right) return 0
    return left < right ? -1 : 1
  })
}

function collectPublicExportNames(program, checker) {
  const names = new Set(EXTRA_PUBLIC_COMPONENT_NAMES)

  for (const indexFile of PUBLIC_INDEX_FILES) {
    const sourceFile = program.getSourceFile(indexFile)
    if (!sourceFile) {
      continue
    }

    const symbol = checker.getSymbolAtLocation(sourceFile)
    if (!symbol) {
      continue
    }

    for (const exported of checker.getExportsOfModule(symbol)) {
      if (/^[A-Z]/.test(exported.name)) {
        names.add(exported.name)
      }
    }
  }

  return names
}

function collectDocumentedApiComponentNames() {
  const files = collectSourceFiles(COMPONENT_LIBRARY_DIR)
  const names = new Set()

  for (const filePath of files) {
    if (filePath === OUTPUT_PATH) {
      continue
    }

    const text = readFileSync(filePath, 'utf-8')
    for (const match of text.matchAll(/apiComponents:\s*\[([\s\S]*?)\]/g)) {
      for (const componentMatch of match[1].matchAll(/['"`]([^'"`]+)['"`]/g)) {
        names.add(componentMatch[1])
      }
    }
  }

  return names
}

function assertPublicComponentsAreDocumented(components, checker, program) {
  const generatedComponentNames = new Set(components.map(([componentName]) => componentName))
  const documentedComponentNames = collectDocumentedApiComponentNames()
  const missing = [...collectPublicExportNames(program, checker)]
    .filter((componentName) => generatedComponentNames.has(componentName))
    .filter((componentName) => !documentedComponentNames.has(componentName))
    .sort()

  if (missing.length) {
    throw new Error(
      [
        'Component library docs are missing apiComponents coverage for public components:',
        ...missing.map((componentName) => `  - ${componentName}`),
        '',
        'Add an auto-discovered registry entry under',
        'component-library/src/componentLibrary/registry/entries/** or update an existing',
        '`apiComponents` array. See registry/README.md.',
      ].join('\n')
    )
  }
}

function stringify(value) {
  return JSON.stringify(value, null, 2)
}

function buildOutput(components) {
  const body = components
    .map(([componentName, rows]) => `  ${componentName}: ${stringify(rows).replace(/\n/g, '\n  ')},`)
    .join('\n')

  return `// Generated by scripts/ui/component-library/generateComponentApi.mjs.\n// Do not edit by hand.\nimport type { ComponentLibraryApiRow } from '../models/componentLibraryTypes'\n\nexport const generatedComponentApiRows: Record<string, ComponentLibraryApiRow[]> = {\n${body}\n}\n`
}

const { program, checker } = readProgram()
const components = collectPropsDeclarations(program, checker)
assertPublicComponentsAreDocumented(components, checker, program)
const output = buildOutput(components)

mkdirSync(dirname(OUTPUT_PATH), { recursive: true })
writeFileSync(OUTPUT_PATH, output)

console.log(
  `Generated ${components.length} component API entries at ${relative(ROOT_DIR, OUTPUT_PATH)}`
)
