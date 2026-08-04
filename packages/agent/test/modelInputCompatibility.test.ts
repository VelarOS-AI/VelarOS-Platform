import type { ModelMessage } from 'ai'
import { describe, expect, test } from 'bun:test'

import type { AgentModelInputModality, ToolDescriptor } from '@velaros-ai/agent/protocol'

import {
  assertModelInputCompatibility,
  collectRequiredModelInputModalities,
} from '../src/agent/model/ModelInputCompatibility'
import { filterToolCategoriesForModelInputs } from '../src/agent/SoloRunPlanPreparer'
import { ToolCapabilityRegistry } from '../src/tools/capability-registry'
import type {
  RegisteredToolMap,
  ToolCapabilityRegistryContext,
} from '../src/tools/capability-types'
import { ToolRegistry } from '../src/tools/registry'
import type { RegistryTool } from '../src/tools/types'

describe('model input compatibility', () => {
  const imageHistory = [
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'computer:screenshot',
          output: {
            type: 'content',
            value: [
              { type: 'text', text: '{"width":1512}' },
              { type: 'image-data', data: 'encoded-image', mediaType: 'image/jpeg' },
            ],
          },
        },
      ],
    },
  ] as ModelMessage[]

  test('detects lifted tool-result images and rejects text-only provider sends', () => {
    expect(collectRequiredModelInputModalities(imageHistory)).toEqual(['text', 'image'])
    expect(() =>
      assertModelInputCompatibility({
        messages: imageHistory,
        supportedInputModalities: ['text'],
        model: 'text-model',
      })
    ).toThrow('未声明支持本次请求所需的输入类型：image')

    expect(() =>
      assertModelInputCompatibility({
        messages: imageHistory,
        supportedInputModalities: ['text', 'image'],
        model: 'vision-model',
      })
    ).not.toThrow()
  })

  test('does not infer media modalities from arbitrary tool input or JSON output fields', () => {
    const structuredData = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'project:edit',
            input: {
              record: { type: 'image', mediaType: 'image/png' },
            },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'project:edit',
            output: {
              type: 'json',
              value: { type: 'audio', mediaType: 'audio/mpeg' },
            },
          },
        ],
      },
    ] as ModelMessage[]

    expect(collectRequiredModelInputModalities(structuredData)).toEqual(['text'])
  })

  test('detects only protocol media parts inside content tool results', () => {
    const mediaHistory = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'audio:capture',
            output: {
              type: 'content',
              value: [{ type: 'media', data: 'encoded-audio', mediaType: 'audio/mpeg' }],
            },
          },
        ],
      },
    ] as ModelMessage[]

    expect(collectRequiredModelInputModalities(mediaHistory)).toEqual(['text', 'audio'])
  })

  test('removes image-result tools from discovery for a text-only model', () => {
    const descriptor = (input: Partial<ToolDescriptor> & Pick<ToolDescriptor, 'name'>) => ({
      name: input.name,
      description: input.name,
      permissions: [],
      categoryId: 'computer-control',
      systemEnabled: true,
      ...input,
    }) satisfies ToolDescriptor
    const categories = [
      {
        category: { id: 'computer-control' },
        tools: [
          descriptor({ name: 'computer:screen_size' }),
          descriptor({
            name: 'computer:screenshot',
            requiredModelInputModalities: ['image'],
          }),
        ],
      },
    ]

    expect(
      filterToolCategoriesForModelInputs(categories, ['text'])[0]?.tools.map((tool) => tool.name)
    ).toEqual(['computer:screen_size'])
    expect(
      filterToolCategoriesForModelInputs(categories, ['text', 'image'])[0]?.tools.map(
        (tool) => tool.name
      )
    ).toEqual(['computer:screen_size', 'computer:screenshot'])
  })

  test('uses the same model-input gate for registry lists and tooling capability pages', () => {
    let supportedInputModalities: readonly AgentModelInputModality[] = ['text']
    const context = {
      role: { id: 'assistant' },
      grantedPermissions: new Set(),
      codingSession: {
        isToolCategoryAllowed: () => true,
        hasToolCategoryAccess: () => true,
        hasActiveToolCategoryAccess: () => true,
        hasPromptFeatureAccess: () => true,
        getToolSurfaceProfile: () => 'full' as const,
        getActiveCapabilityScope: () => 'default',
      },
      isToolSystemEnabled: () => true,
      getCurrentVisibleToolNames: () => [
        'computer:screen_size',
        'computer:screenshot',
      ],
      getSupportedModelInputModalities: () => supportedInputModalities,
    } satisfies ToolCapabilityRegistryContext
    const registered = new Map([
      [
        'computer:screen_size',
        {
          categoryId: 'computer-control',
          tool: {
            description: 'Read screen size',
            permissions: [],
          },
        },
      ],
      [
        'computer:screenshot',
        {
          categoryId: 'computer-control',
          tool: {
            description: 'Capture screenshot',
            permissions: [],
            requiredModelInputModalities: ['image'] as const,
          },
        },
      ],
    ]) satisfies RegisteredToolMap<RegistryTool<ToolCapabilityRegistryContext>>
    const registry = new ToolRegistry()
    const capabilities = new ToolCapabilityRegistry()

    expect(registry.listAvailable(registered, context, undefined, 'all').map((tool) => tool.name))
      .toEqual(['computer:screen_size'])
    expect(capabilities.listCapabilityPages(registered, context).map((page) => page.name)).toEqual([
      'computer:screen_size',
    ])

    supportedInputModalities = ['text', 'image']
    expect(registry.listAvailable(registered, context, undefined, 'all').map((tool) => tool.name))
      .toEqual(['computer:screen_size', 'computer:screenshot'])
    expect(capabilities.listCapabilityPages(registered, context).map((page) => page.name)).toEqual([
      'computer:screen_size',
      'computer:screenshot',
    ])
  })
})
