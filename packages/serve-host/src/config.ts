import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { z } from 'zod'

import { isEmpty, stringifyPretty } from '@velaros-ai/core'

export const VelarHostCapabilityConfirmationSchema = z.enum([
  'project-write',
  'project-execute',
  'system-observe',
  'system-read',
  'system-write',
  'system-execute',
  'computer-observe',
  'computer-control',
  'remote-node-enable',
  'remote-node-expose',
])
export type VelarHostCapabilityConfirmation = z.infer<
  typeof VelarHostCapabilityConfirmationSchema
>

const VelarHostSystemCapabilitySchema = z.strictObject({
  observe: z.boolean(),
  read: z.boolean(),
  write: z.boolean(),
  execute: z.boolean(),
})

/**
 * 远程能力节点开关。
 *
 * 这是本配置里唯一能把能力面送出本机的一节，故三个字段全部显式持久化、不留隐式默认：
 * `bindHost` 默认回环，端口区间与插件桥一样是「区间内挑一个可用口」而不是单口硬绑。
 */
const VelarHostRemoteNodeSchema = z.strictObject({
  enabled: z.boolean(),
  bindHost: z.string().min(1).max(255),
  portStart: z.number().int().min(1_024).max(65_535),
  portEnd: z.number().int().min(1_024).max(65_535),
})

export const VelarHostConfigSchema = z.strictObject({
  schemaVersion: z.literal(4),
  capabilities: z.strictObject({
    project: z.strictObject({
      read: z.boolean(),
      write: z.boolean(),
      execute: z.boolean(),
    }),
    system: VelarHostSystemCapabilitySchema,
    computer: z.strictObject({
      observe: z.boolean(),
      control: z.boolean(),
    }),
  }),
  computer: z.strictObject({
    resourceRoots: z.array(z.string().min(1).max(4_096)).max(16),
  }),
  remoteNode: VelarHostRemoteNodeSchema,
})
export type VelarHostConfig = z.infer<typeof VelarHostConfigSchema>

/**
 * v3 存量形状：与 v4 只差 `remoteNode` 一节。
 *
 * 新增是纯追加，能无损升级，故这里保留一条读取路径而不是让老配置整个失效——真正无法自动迁移
 * 的形状变化（如 v2→v3 的能力轴改名）才该直接作废。
 */
const LegacyVelarHostConfigSchema = z.strictObject({
  schemaVersion: z.literal(3),
  capabilities: z.strictObject({
    project: z.strictObject({
      read: z.boolean(),
      write: z.boolean(),
      execute: z.boolean(),
    }),
    system: VelarHostSystemCapabilitySchema,
    computer: z.strictObject({
      observe: z.boolean(),
      control: z.boolean(),
    }),
  }),
  computer: z.strictObject({
    resourceRoots: z.array(z.string().min(1).max(4_096)).max(16),
  }),
})

export const VelarHostConfigUpdateSchema = z.strictObject({
  capabilities: z.strictObject({
    project: z.strictObject({
      read: z.boolean(),
      write: z.boolean(),
      execute: z.boolean(),
    }),
    system: VelarHostSystemCapabilitySchema,
    computer: z.strictObject({
      observe: z.boolean(),
      control: z.boolean(),
    }),
  }),
  computer: z.strictObject({
    resourceRoots: z.array(z.string().min(1).max(4_096)).max(16),
  }),
  remoteNode: VelarHostRemoteNodeSchema,
  confirmations: z.array(VelarHostCapabilityConfirmationSchema).max(10),
})
export type VelarHostConfigUpdate = z.infer<typeof VelarHostConfigUpdateSchema>

export interface VelarHostConfigSnapshot {
  readonly revision: string
  readonly value: VelarHostConfig
}

/** 默认端口区间：与插件桥（43137-43147）错开，避免互相抢口。 */
const DefaultRemoteNodePortStart = 43_180
const DefaultRemoteNodePortEnd = 43_190

const DefaultVelarHostConfig: VelarHostConfig = {
  schemaVersion: 4,
  capabilities: {
    project: { read: true, write: false, execute: false },
    system: { observe: false, read: false, write: false, execute: false },
    computer: { observe: false, control: false },
  },
  computer: { resourceRoots: [] },
  remoteNode: {
    enabled: false,
    bindHost: '127.0.0.1',
    portStart: DefaultRemoteNodePortStart,
    portEnd: DefaultRemoteNodePortEnd,
  },
}

function cloneConfig(value: VelarHostConfig): VelarHostConfig {
  return structuredClone(value)
}

function configRevision(value: VelarHostConfig): string {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('base64url')
    .slice(0, 24)
}

function normalizeResourceRoots(roots: readonly string[]): string[] {
  return [...new Set(roots.map((root) => root.trim()).filter(Boolean))]
}

/**
 * 判定一个绑定地址是否仍留在本机回环内。
 *
 * 只认回环本身：`0.0.0.0` / `::` / 任何具体网卡地址都算「离开本机」，因为它们都会让配对入口
 * 出现在局域网上。判据故意保守——认错一次的代价是多一次确认，反过来是静默对外开门。
 */
function isLoopbackBindHost(bindHost: string): boolean {
  const host = bindHost.trim().toLowerCase()
  return host === 'localhost' || host === '::1' || host.startsWith('127.')
}

function assertSafeConfigDependencies(value: VelarHostConfig): void {
  if (value.capabilities.project.write && !value.capabilities.project.read) {
    throw new Error('Project write access requires project read access')
  }
  if (value.capabilities.computer.control && !value.capabilities.computer.observe) {
    throw new Error('Computer control requires computer observation access')
  }
  if (value.capabilities.system.write && !value.capabilities.system.read) {
    throw new Error('System write access requires system read access')
  }
  if (value.remoteNode.portStart > value.remoteNode.portEnd) {
    throw new Error('Remote node access requires portStart to be at most portEnd')
  }
}

function requiredConfirmations(
  current: VelarHostConfig,
  next: VelarHostConfig,
): VelarHostCapabilityConfirmation[] {
  const confirmations: VelarHostCapabilityConfirmation[] = []
  if (!current.capabilities.project.write && next.capabilities.project.write) {
    confirmations.push('project-write')
  }
  if (!current.capabilities.project.execute && next.capabilities.project.execute) {
    confirmations.push('project-execute')
  }
  if (!current.capabilities.system.observe && next.capabilities.system.observe) {
    confirmations.push('system-observe')
  }
  if (!current.capabilities.system.read && next.capabilities.system.read) {
    confirmations.push('system-read')
  }
  if (!current.capabilities.system.write && next.capabilities.system.write) {
    confirmations.push('system-write')
  }
  if (!current.capabilities.system.execute && next.capabilities.system.execute) {
    confirmations.push('system-execute')
  }
  if (!current.capabilities.computer.observe && next.capabilities.computer.observe) {
    confirmations.push('computer-observe')
  }
  if (!current.capabilities.computer.control && next.capabilities.computer.control) {
    confirmations.push('computer-control')
  }
  // 远程节点是本配置里唯一把能力面送出本机的轴，故「开启」与「绑定地址离开回环」各要一次
  // 显式确认；关闭与收窄回回环不需要——收紧永远不该被拦。
  if (!current.remoteNode.enabled && next.remoteNode.enabled) {
    confirmations.push('remote-node-enable')
  }
  if (
    !isLoopbackBindHost(next.remoteNode.bindHost)
    && next.remoteNode.bindHost !== current.remoteNode.bindHost
  ) {
    confirmations.push('remote-node-expose')
  }
  return confirmations
}

/** Persistent, credential-free configuration authority for one Host data root. */
export class VelarHostConfigStore {
  private readonly listeners = new Set<(snapshot: VelarHostConfigSnapshot) => void>()
  private mutation = Promise.resolve()
  private value: VelarHostConfig

  private constructor(
    private readonly path: string,
    value: VelarHostConfig,
  ) {
    this.value = value
  }

  public static async open(path: string): Promise<VelarHostConfigStore> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
      const current = VelarHostConfigSchema.safeParse(parsed)
      const legacy = current.success ? null : LegacyVelarHostConfigSchema.safeParse(parsed)
      // 升级只补默认值：远程节点一律以「关闭 + 回环」落地，绝不从老配置推断出一个已开启的对外面。
      const value = current.success
        ? current.data
        : legacy?.success
          ? VelarHostConfigSchema.parse({
              ...legacy.data,
              schemaVersion: 4,
              remoteNode: cloneConfig(DefaultVelarHostConfig).remoteNode,
            })
          : VelarHostConfigSchema.parse(parsed)
      assertSafeConfigDependencies(value)
      const store = new VelarHostConfigStore(path, value)
      if (legacy?.success) await store.persist(value)
      return store
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) {
        throw new Error(
          `Velar Host config is invalid: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      const store = new VelarHostConfigStore(path, cloneConfig(DefaultVelarHostConfig))
      await store.persist(store.value)
      return store
    }
  }

  public snapshot(): VelarHostConfigSnapshot {
    const value = cloneConfig(this.value)
    return { revision: configRevision(value), value }
  }

  public update(input: VelarHostConfigUpdate): Promise<VelarHostConfigSnapshot> {
    const parsed = VelarHostConfigUpdateSchema.parse(input)
    const operation = this.mutation.then(async () => {
      const next = VelarHostConfigSchema.parse({
        schemaVersion: 4,
        capabilities: parsed.capabilities,
        computer: {
          resourceRoots: normalizeResourceRoots(parsed.computer.resourceRoots),
        },
        remoteNode: {
          ...parsed.remoteNode,
          bindHost: parsed.remoteNode.bindHost.trim(),
        },
      })
      assertSafeConfigDependencies(next)
      const confirmations = new Set(parsed.confirmations)
      const missing = requiredConfirmations(this.value, next)
        .filter((confirmation) => !confirmations.has(confirmation))
      if (!isEmpty(missing)) {
        throw new Error(`Explicit confirmation required: ${missing.join(', ')}`)
      }
      await this.persist(next)
      this.value = next
      const result = this.snapshot()
      for (const listener of this.listeners) listener(result)
      return result
    })
    // 调用方仍收到原始 rejection；这里只把队列尾归一，保证一次失败不会冻结后续更新。
    this.mutation = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  public subscribe(
    listener: (snapshot: VelarHostConfigSnapshot) => void,
  ): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private async persist(value: VelarHostConfig): Promise<void> {
    const temporaryPath = `${this.path}.${process.pid}.tmp`
    await writeFile(temporaryPath, `${stringifyPretty(value)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    await rename(temporaryPath, this.path)
    await chmod(this.path, 0o600)
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}
