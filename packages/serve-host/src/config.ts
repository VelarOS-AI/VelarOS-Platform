import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { z } from 'zod'

import { isEmpty, stringifyPretty } from '@velaros-ai/core'

export const VelarHostCapabilityConfirmationSchema = z.enum([
  'workspace-write',
  'system-observe',
  'system-read',
  'system-write',
  'system-execute',
  'computer-observe',
  'computer-control',
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

const LegacyVelarHostConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  capabilities: z.strictObject({
    workspace: z.strictObject({
      read: z.boolean(),
      write: z.boolean(),
    }),
    computer: z.strictObject({
      observe: z.boolean(),
      control: z.boolean(),
    }),
  }),
  computer: z.strictObject({
    resourceRoots: z.array(z.string().min(1).max(4_096)).max(16),
  }),
})

export const VelarHostConfigSchema = z.strictObject({
  schemaVersion: z.literal(2),
  capabilities: z.strictObject({
    workspace: z.strictObject({
      read: z.boolean(),
      write: z.boolean(),
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
export type VelarHostConfig = z.infer<typeof VelarHostConfigSchema>

export const VelarHostConfigUpdateSchema = z.strictObject({
  capabilities: z.strictObject({
    workspace: z.strictObject({
      read: z.boolean(),
      write: z.boolean(),
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
  confirmations: z.array(VelarHostCapabilityConfirmationSchema).max(7),
})
export type VelarHostConfigUpdate = z.infer<typeof VelarHostConfigUpdateSchema>

export interface VelarHostConfigSnapshot {
  readonly revision: string
  readonly value: VelarHostConfig
}

const DefaultVelarHostConfig: VelarHostConfig = {
  schemaVersion: 2,
  capabilities: {
    workspace: { read: true, write: false },
    system: { observe: false, read: false, write: false, execute: false },
    computer: { observe: false, control: false },
  },
  computer: { resourceRoots: [] },
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

function assertSafeCapabilityDependencies(value: VelarHostConfig): void {
  if (value.capabilities.workspace.write && !value.capabilities.workspace.read) {
    throw new Error('Workspace write access requires workspace read access')
  }
  if (value.capabilities.computer.control && !value.capabilities.computer.observe) {
    throw new Error('Computer control requires computer observation access')
  }
  if (value.capabilities.system.write && !value.capabilities.system.read) {
    throw new Error('System write access requires system read access')
  }
}

function requiredConfirmations(
  current: VelarHostConfig,
  next: VelarHostConfig,
): VelarHostCapabilityConfirmation[] {
  const confirmations: VelarHostCapabilityConfirmation[] = []
  if (!current.capabilities.workspace.write && next.capabilities.workspace.write) {
    confirmations.push('workspace-write')
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
      const value = current.success
        ? current.data
        : legacy?.success
          ? VelarHostConfigSchema.parse({
              schemaVersion: 2,
              capabilities: {
                ...legacy.data.capabilities,
                system: { observe: false, read: false, write: false, execute: false },
              },
              computer: legacy.data.computer,
            })
          : VelarHostConfigSchema.parse(parsed)
      assertSafeCapabilityDependencies(value)
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
        schemaVersion: 2,
        capabilities: parsed.capabilities,
        computer: {
          resourceRoots: normalizeResourceRoots(parsed.computer.resourceRoots),
        },
      })
      assertSafeCapabilityDependencies(next)
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
