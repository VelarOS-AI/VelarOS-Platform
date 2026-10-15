import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

// 宿主提供自包含的正式产物适配器；冻结副本与模型候选分别记录，旧实验保持原装配。
export async function freezeRuntimeCompletion(config, directory) {
  if (config === undefined) return undefined
  assert(config && typeof config === 'object', 'Invalid Runtime completion configuration')
  assert.equal(typeof config.module, 'string')
  assert(isAbsolute(config.module), 'Completion artifact module must use an absolute path')
  assert.match(config.exportName, /^[A-Za-z_$][A-Za-z0-9_$]*$/u)
  assert(
    config.validation === undefined || config.validation === 'node-isolated',
    'Unknown completion validation mode'
  )
  assert(
    config.discoverEvidence === undefined || typeof config.discoverEvidence === 'boolean',
    'Invalid completion evidence discovery configuration'
  )
  assert(
    config.counterexampleReview === undefined || typeof config.counterexampleReview === 'boolean',
    'Invalid counterexample review configuration'
  )
  assert(
    !config.counterexampleReview || config.validation === 'node-isolated',
    'Counterexample review requires isolated validation'
  )
  const bytes = await readFile(config.module)
  const host = join(directory, 'host')
  await mkdir(host, { recursive: true })
  const module = join(host, 'completion-artifacts.mjs')
  await writeFile(module, bytes, { flag: 'wx' })
  return {
    module,
    exportName: config.exportName,
    sha256: hash(bytes),
    ...(config.validation ? { validation: config.validation } : {}),
    ...(config.discoverEvidence === undefined ? {} : { discoverEvidence: config.discoverEvidence }),
    ...(config.counterexampleReview === undefined
      ? {}
      : { counterexampleReview: config.counterexampleReview }),
  }
}

// 在模型请求前核对冻结字节；通过 Runtime 公共 completion 端口接入同一正式复核。
export async function runtimeCompletionOptions(frozen, workspace, host = {}) {
  if (frozen === undefined) return undefined
  assert.equal(hash(await readFile(frozen.module)), frozen.sha256, 'Completion adapter changed')
  const url = pathToFileURL(frozen.module)
  url.searchParams.set('sha256', frozen.sha256)
  const Adapter = (await import(url.href))[frozen.exportName]
  assert.equal(typeof Adapter, 'function', 'Missing completion artifact adapter export')
  const artifacts = new Adapter(workspace)
  assert.equal(typeof artifacts.capture, 'function', 'Completion adapter must capture artifacts')
  let validation
  if (frozen.validation) {
    assert.equal(frozen.validation, 'node-isolated', 'Unknown frozen completion validation mode')
    assert.equal(
      typeof host.createValidationHost,
      'function',
      'Frozen candidate lacks the requested validation host'
    )
    assert(
      isAbsolute(host.executable ?? ''),
      'Validation requires a frozen absolute Node executable'
    )
    validation = host.createValidationHost({
      workspace,
      artifacts,
      executable: host.executable,
      signal: host.signal,
    })
    assert.equal(typeof validation?.execute, 'function', 'Validation host has no execution port')
  }
  assert(
    frozen.discoverEvidence === undefined || typeof frozen.discoverEvidence === 'boolean',
    'Invalid frozen evidence discovery configuration'
  )
  assert(
    frozen.counterexampleReview === undefined || typeof frozen.counterexampleReview === 'boolean',
    'Invalid frozen counterexample review configuration'
  )
  assert(
    !frozen.counterexampleReview || validation,
    'Frozen counterexample review requires isolated validation'
  )
  return {
    kind: 'model-review',
    artifacts,
    ...(validation ? { validation } : {}),
    ...(frozen.discoverEvidence === undefined ? {} : { discoverEvidence: frozen.discoverEvidence }),
    ...(frozen.counterexampleReview === undefined
      ? {}
      : { counterexampleReview: frozen.counterexampleReview }),
  }
}
