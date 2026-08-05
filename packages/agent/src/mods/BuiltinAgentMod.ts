// 域：官方内置轴的自食狗粮（裁决 6 / M1「注册机不空转」）。
//
// Agent Runtime 自带的工具库、提示词段与执行模式**不是特权硬编码**，而是第一个 bundled
// AgentModManifest 消费者——与外部 mod 走完全相同的 validate → resolve → activate 管线。
//
// 行为零变化的结构性保证：
//  ① manifest 由既有单源**派生**（`Object.keys(collection)` / `createBuiltInPromptSegments()` /
//     `listExecutionModes()`），不另立一份清单，故不可能与实现漂移；
//  ② 绑定直接引用原实体，Loader 与投影全程不复制不包装，载荷对象同一性逐项保持。
import { isBoolean, isString, optionalWhen, toOptional } from '@velaros-ai/core'

import type { ExecutionModeDescriptor } from '../execution-modes'
import { listExecutionModes } from '../execution-modes'
import type { PromptSegmentDefinition } from '../prompts'
import {
  type BuiltInPromptOptions,
  createBuiltInPromptSegments,
  resolvePromptSegmentStability,
} from '../prompts'
import type {
  AgentModExecutionModeContribution,
  AgentModManifest,
  AgentModPromptSegmentContribution,
  AgentModToolContribution,
} from '../protocol'
import { AgentModManifestSchemaVersion } from '../protocol'
import {
  activeDirectiveTools,
  agentWorkflowTools,
  backgroundJobTools,
  categoriesTools,
  contextDistillTools,
  contextRetrievalTools,
  dispatchAgentTools,
  goalTools,
  plansTools,
  type VelaTool,
} from '../tool-library'

import type { AgentModBindings, AgentModPackage } from './AgentModLoader'

/** 随包官方 Agent mod 的稳定 id（恒加载，永不孤儿）。 */
const BuiltinAgentModId = 'velaros.agent.builtin'

/** 内置工具库单源：新增内置工具集合只在此追加，manifest 自动跟随。 */
const BuiltinAgentModToolCollections: ReadonlyArray<Readonly<
  Record<string, VelaTool<any>>
>> = [
  activeDirectiveTools,
  { ...agentWorkflowTools },
  backgroundJobTools,
  categoriesTools,
  contextDistillTools,
  contextRetrievalTools,
  dispatchAgentTools,
  goalTools,
  plansTools,
]

/** 展平内置工具集合；重复工具名在此即抛（不留到 Loader 才发现）。 */
function collectBuiltinAgentModTools(): Record<string, VelaTool<any>> {
  const tools: Record<string, VelaTool<any>> = {}
  for (const collection of BuiltinAgentModToolCollections) {
    for (const [name, tool] of Object.entries(collection)) {
      if (name in tools) {
        throw new Error(`内置工具名重复：${name}（内置集合之间必须互斥）。`)
      }
      tools[name] = tool
    }
  }
  return tools
}

function toToolContribution(
  name: string,
  tool: VelaTool<any>
): AgentModToolContribution {
  const category = Reflect.get(tool, 'category')
  const summary = Reflect.get(tool, 'summary')
  const readOnly = Reflect.get(tool, 'readOnly')
  return {
    name,
    categoryId: optionalWhen(isString(category), category),
    summary: optionalWhen(isString(summary), summary),
    readOnly: optionalWhen(isBoolean(readOnly), readOnly),
  }
}

function toPromptSegmentContribution(
  definition: PromptSegmentDefinition
): AgentModPromptSegmentContribution {
  return {
    id: definition.id,
    label: toOptional(definition.label),
    stability: resolvePromptSegmentStability(definition.tier),
    priority: definition.priority,
    retention: toOptional(definition.retention),
  }
}

function toExecutionModeContribution(
  descriptor: ExecutionModeDescriptor
): AgentModExecutionModeContribution {
  return {
    id: descriptor.id,
    label: descriptor.label,
    promptFeatureId: descriptor.prompt.legacyPromptFeatureId,
    sessionSticky: descriptor.stickiness.sessionSticky,
  }
}

interface BuiltinAgentModOptions {
  /** 透传给内置提示词段构造（宿主身份说明）。 */
  promptOptions?: BuiltInPromptOptions
  /** 随主包版本流转；缺省与 manifest schema 同档的保守值。 */
  version?: string
}

interface BuiltinAgentModPackage extends AgentModPackage {
  readonly manifest: AgentModManifest
  readonly bindings: AgentModBindings
}

/**
 * 构造随包官方 Agent mod。
 *
 * 恒加载（trust=bundled-official），三轴贡献：内置工具库 / 内置提示词段 / 官方执行模式。
 * 技能轴刻意缺席——Agent Runtime 自身不带内置技能定义（技能由宿主的文件式供应方注入），
 * 声明空轴只会制造零消费者的假贡献。
 */
function createBuiltinAgentModPackage(
  options: BuiltinAgentModOptions = {}
): BuiltinAgentModPackage {
  const tools = collectBuiltinAgentModTools()
  const promptSegments = createBuiltInPromptSegments(options.promptOptions)
  const executionModes = listExecutionModes()

  const manifest: AgentModManifest = {
    id: BuiltinAgentModId,
    version: options.version ?? '1.0.0',
    publisher: 'VelarOS',
    displayName: 'VelarOS Agent 内置轴',
    description:
      'Agent Runtime 随包提供的内置工具库、提示词段与官方执行模式，经领域 Loader 恒加载。',
    manifestSchemaVersion: AgentModManifestSchemaVersion,
    engines: { velaros: '*', agent: '*' },
    trust: 'bundled-official',
    contributes: {
      tools: Object.entries(tools).map(([name, tool]) =>
        toToolContribution(name, tool)
      ),
      promptSegments: promptSegments.map(toPromptSegmentContribution),
      executionModes: executionModes.map(toExecutionModeContribution),
    },
  }

  const bindings: AgentModBindings = {
    tools,
    promptSegments: Object.fromEntries(
      promptSegments.map((definition) => [definition.id, definition])
    ),
    executionModes: Object.fromEntries(
      executionModes.map((descriptor) => [descriptor.id, descriptor])
    ),
  }

  return {
    source: 'bundled',
    origin: BuiltinAgentModId,
    manifest,
    bindings,
  }
}

export {
  BuiltinAgentModId,
  BuiltinAgentModToolCollections,
  collectBuiltinAgentModTools,
  createBuiltinAgentModPackage,
}
export type { BuiltinAgentModOptions, BuiltinAgentModPackage }
