import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, test } from 'bun:test'
import * as ts from 'typescript'

import { schemaToInputSchema } from '@velaros-ai/agent/tool-contract'

import disposition from '../../../docs/engineering/project-tool-operation-disposition.json'
import { projectTools } from '../src/agent/Project.tool'
import { LegacyProjectWriteModeSchema } from '../src/compatibility/agent-tools'
import { ProjectModelEditSchema } from '../src/edits/schema'
import { ProjectCodeAnalysisSchema } from '../src/project-code-contracts'
import { ProjectCodeQuerySchema } from '../src/project-code-query'
import { LegacyProjectToolNames } from '../src/project-tool-names'

const root = resolve(import.meta.dir, '..')

function discriminants(value: unknown, property: string): string[] {
  if (!value || typeof value !== 'object') return []
  const object = value as Record<string, any>
  const own = object.properties?.[property]?.const
  return [...new Set([
    ...(typeof own === 'string' ? [own] : []),
    ...Object.values(object).flatMap((entry) => Array.isArray(entry)
      ? entry.flatMap((item) => discriminants(item, property)) : discriminants(entry, property)),
  ])].sort()
}

function sdkOperations(): string[] {
  const path = resolve(root, 'src/types/edit.ts')
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const union = source.statements.find((node) => ts.isTypeAliasDeclaration(node) && node.name.text === 'EditOperation') as ts.TypeAliasDeclaration
  if (!ts.isUnionTypeNode(union.type)) throw new Error('EditOperation must remain an inspectable SDK union')
  const names = new Set(union.type.types.map((node) => node.getText(source)))
  return source.statements.flatMap((node) => {
    if (!ts.isInterfaceDeclaration(node) || !names.has(node.name.text)) return []
    const type = node.members.find((member) => ts.isPropertySignature(member) && member.name.getText(source) === 'type') as ts.PropertySignature | undefined
    return type?.type && ts.isLiteralTypeNode(type.type) && ts.isStringLiteral(type.type.literal) ? [type.type.literal.text] : []
  }).sort()
}

describe('operation disposition is tied to executable contracts', () => {
  test('enumerates each legacy tool, model edit, write mode and code query exactly once', () => {
    const groups = {
      tool: Object.values(LegacyProjectToolNames).sort(),
      edit: discriminants(schemaToInputSchema(ProjectModelEditSchema), 'type'),
      write: [...LegacyProjectWriteModeSchema.options].sort(),
      query: discriminants(schemaToInputSchema(ProjectCodeQuerySchema), 'action'),
    }
    for (const [group, actual] of Object.entries(groups)) {
      const listed = disposition.rows.filter((row) => row.group === group).map((row) => row.operation).sort()
      expect(listed, group).toEqual(actual)
      expect(new Set(listed).size, `${group} contains duplicate dispositions`).toBe(listed.length)
    }
    const modelSdk = groups.edit.filter((name) => name !== 'replace_selection')
    const newInternal = disposition.newInternalOperations.map((row) => row.operation)
    const additionalSdk = sdkOperations().filter((name) => !modelSdk.includes(name) && !newInternal.includes(name))
    expect(disposition.rows.filter((row) => row.group === 'sdk').map((row) => row.operation).sort()).toEqual(additionalSdk)
    expect(sdkOperations()).toEqual([...modelSdk, ...additionalSdk, ...newInternal].sort())
  })

  test('every replacement recipe is accepted by its actual destination tool or host query contract', () => {
    for (const row of disposition.rows) {
      const destination = row.destination
      if (destination.kind === 'tool') {
        const schema = destination.name === 'project:code-analysis' ? ProjectCodeAnalysisSchema : projectTools[destination.name]?.schema
        expect(schema, `${row.group}.${row.operation} destination exists`).toBeDefined()
        const result = schema!.safeParse(destination.input)
        expect(result.success, `${row.group}.${row.operation}: ${result.success ? '' : result.error.message}`).toBe(true)
      } else if (row.group === 'query') {
        expect(ProjectCodeQuerySchema.safeParse(destination.input).success, row.operation).toBe(true)
      }
    }
  })

  test('retained SDK recipes typecheck against the published operation union', () => {
    const fixture = resolve(root, 'test/__operation_disposition_typecheck__.ts')
    const examples = [...disposition.rows.filter((row) => row.group === 'sdk').map((row) => row.destination.input), ...disposition.newInternalOperations.map((row) => row.example)]
    const code = `import type { EditOperation } from '../src/types/edit';\n${examples.map((example, index) => `const operation${index}: EditOperation = ${JSON.stringify(example)};`).join('\n')}`
    const options: ts.CompilerOptions = { strict: true, skipLibCheck: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler }
    const host = ts.createCompilerHost(options)
    const read = host.readFile.bind(host)
    const exists = host.fileExists.bind(host)
    host.readFile = (path) => path === fixture ? code : read(path)
    host.fileExists = (path) => path === fixture || exists(path)
    const program = ts.createProgram([fixture, resolve(root, 'src/velaros-globals.d.ts')], options, host)
    expect(program.getSourceFile(fixture)).toBeDefined()
    const errors = ts.getPreEmitDiagnostics(program).filter((item) => item.file?.fileName === fixture)
    expect(errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n'))).toEqual([])
  })
})
