import { isObject } from '../typeGuards'
import { structureToolDescriptionForModel } from '../utils/ToolDescription'

import {
  DefaultToolContractExampleRegistry,
  renderToolExampleInputs,
  type ToolContractExampleRegistry,
} from './examples'
import type {
  DefineToolContractInput,
  DefineToolRuntimeSpecInput,
  ToolContractDescriptionSpec,
  ToolContractRuntimeSpec,
  ToolContractSpec,
  ToolContractSurface,
} from './types'

function validateToolContractExamples(
  toolName: string,
  schema: {
    safeParse(
      input: unknown
    ):
      | { success: true }
      | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } }
  },
  examples: ReadonlyArray<Record<string, unknown>>
): void {
  for (const example of examples) {
    const parsed = schema.safeParse(example)
    if (parsed.success) {
      continue
    }

    const issues = parsed.error.issues
      .map((issue) => {
        const path = issue.path.map(String).join('.') || '<root>'
        return `${path}: ${issue.message}`
      })
      .join('; ')

    throw new Error(
      `Tool contract ${toolName} example does not satisfy schema: ${JSON.stringify(example)} (${issues})`
    )
  }
}

function buildToolContractDescription(
  name: string,
  categoryId: DefineToolContractInput['category'],
  spec: ToolContractDescriptionSpec,
  examples: ToolContractExampleRegistry = DefaultToolContractExampleRegistry
): string {
  examples.set(name, spec.examples)
  return structureToolDescriptionForModel({
    categoryId,
    description: spec.summary,
    suitable: spec.suitable,
    forbidden: spec.forbidden,
    protocol: spec.protocol,
    usage: spec.usage,
    examples: renderToolExampleInputs(spec.examples),
    notes: spec.notes,
  })
}

function defineToolContract<TInput extends Record<string, unknown>, TContext = unknown>(
  input: DefineToolContractInput<TInput, TContext>,
  examples: ToolContractExampleRegistry = DefaultToolContractExampleRegistry
): ToolContractSpec<TInput, TContext> {
  const descriptionSpec: ToolContractDescriptionSpec = {
    role: input.role,
    summary: input.summary,
    suitable: input.suitable,
    forbidden: input.forbidden,
    protocol: input.protocol,
    usage: input.usage,
    examples: input.examples,
    notes: input.notes,
  }
  validateToolContractExamples(input.name, input.schema, descriptionSpec.examples)
  return {
    name: input.name,
    category: input.category,
    role: input.role,
    descriptionSpec,
    description: buildToolContractDescription(
      input.name,
      input.category,
      descriptionSpec,
      examples
    ),
    examples: input.examples,
    schema: input.schema,
    executeSchema: input.executeSchema,
    surfaces: input.surfaces,
    permissions: input.permissions ?? [],
    capabilities: input.capabilities,
    exposure: input.exposure,
    hideWhenUnavailable: input.hideWhenUnavailable,
    isAvailable: input.isAvailable,
    isConcurrencySafe: input.isConcurrencySafe,
    execute: input.execute,
  }
}

function defineToolRuntimeSpec<
  TInput extends Record<string, unknown>,
  TContext = unknown,
  TResult = unknown,
  TPermission extends string = string,
>(
  input: DefineToolRuntimeSpecInput<TInput, TContext, TResult, TPermission>,
  examples: ToolContractExampleRegistry = DefaultToolContractExampleRegistry
): ToolContractRuntimeSpec<TInput, TContext, TResult, TPermission> {
  const descriptionSpec: ToolContractDescriptionSpec = {
    role: input.role,
    summary: input.summary,
    suitable: input.suitable,
    forbidden: input.forbidden,
    protocol: input.protocol,
    usage: input.usage,
    examples: input.examples,
    notes: input.notes,
  }
  validateToolContractExamples(input.name, input.schema, descriptionSpec.examples)

  const surfaces = input.surfaces
    ? (Object.fromEntries(
        Object.entries(input.surfaces).map(([profile, surface]) => {
          if (!surface) return [profile, surface]
          validateToolContractExamples(`${input.name}.${profile}`, surface.schema, surface.examples)
          const surfaceSpec: ToolContractDescriptionSpec = {
            role: surface.role,
            summary: surface.summary,
            suitable: surface.suitable,
            forbidden: surface.forbidden,
            protocol: surface.protocol,
            usage: surface.usage,
            examples: surface.examples,
            notes: surface.notes,
          }
          return [
            profile,
            {
              description: buildToolContractDescription(
                `${input.name}.${profile}`,
                input.category,
                surfaceSpec,
                examples
              ),
              schema: surface.schema,
              normalize: surface.normalize,
            } satisfies ToolContractSurface<any, TInput, TContext>,
          ]
        })
      ) as ToolContractRuntimeSpec<TInput, TContext, TResult, TPermission>['surfaces'])
    : undefined

  return {
    name: input.name,
    role: input.role,
    description: buildToolContractDescription(
      input.name,
      input.category,
      descriptionSpec,
      examples
    ),
    schema: input.schema,
    surfaces,
    permissions: input.permissions,
    capabilities: input.capabilities,
    exposure: input.exposure,
    outputInline: input.outputInline,
    hideWhenUnavailable: input.hideWhenUnavailable,
    isAvailable: input.isAvailable,
    isConcurrencySafe: input.isConcurrencySafe,
    execute: input.execute,
  }
}

function isToolContractSpec(
  value: unknown
): value is ToolContractSpec<Record<string, unknown>, unknown> {
  return (
    isObject(value) &&
    'name' in value &&
    'category' in value &&
    'role' in value &&
    'description' in value &&
    'schema' in value &&
    'execute' in value
  )
}

export {
  buildToolContractDescription,
  defineToolContract,
  defineToolRuntimeSpec,
  isToolContractSpec,
}
