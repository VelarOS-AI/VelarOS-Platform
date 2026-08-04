import { createHash } from 'node:crypto'
import {
  mkdtemp,
  rm,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { KernelFetch } from '../../../src/serve/updater'

export function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

export function digestOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export interface TestArtifactDescriptor {
  readonly url: string
  readonly size: number
  readonly sha256: string
}

export interface TestArtifact {
  readonly bytes: Uint8Array
  readonly descriptor: TestArtifactDescriptor
}

export function artifactOf(url: string, contents: string): TestArtifact {
  const bytes = encode(contents)
  return {
    bytes,
    descriptor: { url, size: bytes.byteLength, sha256: digestOf(bytes) },
  }
}

export interface TestManifestVersion {
  readonly version: string
  readonly yanked?: boolean
  readonly artifacts: Readonly<Record<string, unknown>>
}

export function manifestOf(versions: readonly TestManifestVersion[]): unknown {
  return { schemaVersion: 1, channel: 'stable', versions }
}

export interface FakeFetchOptions {
  readonly status?: number
  readonly interruptAfterBytes?: number
  readonly interruptUrls?: readonly string[]
  readonly chunkSize?: number
  readonly onRequest?: (url: string) => void
}

export function createFakeFetch(
  resources: Readonly<Record<string, Uint8Array | string>>,
  options: FakeFetchOptions = {},
): KernelFetch {
  const chunkSize = options.chunkSize ?? 8
  return (request) => {
    options.onRequest?.(request.url)
    const resource = resources[request.url]
    const status = resource === undefined ? 404 : (options.status ?? 200)
    const available = status === 200 ? resource : undefined
    return Promise.resolve({
      status,
      body: available === undefined
        ? emptyBody()
        : chunkedBody(
          toBytes(available),
          chunkSize,
          interruptionFor(request.url, options),
        ),
    })
  }
}

export function createTemporaryDirectories(prefix: string): {
  create: () => Promise<string>
  cleanup: () => Promise<void>
} {
  const created: string[] = []
  return {
    async create() {
      const directory = await mkdtemp(
        join(tmpdir(), `velaros-kernel-updater-${prefix}-`),
      )
      created.push(directory)
      return directory
    },
    async cleanup() {
      for (const directory of created.splice(0)) {
        await rm(directory, { recursive: true, force: true })
      }
    },
  }
}

function toBytes(resource: Uint8Array | string): Uint8Array {
  return typeof resource === 'string' ? encode(resource) : resource
}

function interruptionFor(
  url: string,
  options: FakeFetchOptions,
): number | undefined {
  if (options.interruptUrls === undefined) return options.interruptAfterBytes
  return options.interruptUrls.includes(url)
    ? options.interruptAfterBytes
    : undefined
}

async function* chunkedBody(
  bytes: Uint8Array,
  chunkSize: number,
  interruptAfterBytes?: number,
): AsyncGenerator<Uint8Array> {
  let sent = 0
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    if (interruptAfterBytes !== undefined && sent >= interruptAfterBytes) {
      throw new Error('connection reset by peer')
    }
    const chunk = bytes.subarray(offset, offset + chunkSize)
    sent += chunk.byteLength
    yield chunk
  }
}

async function* emptyBody(): AsyncGenerator<Uint8Array> {}
