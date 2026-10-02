import { access, appendFile, mkdir, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { platform, arch } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'

import { createRuntime, createShellCapabilityModule } from '@velaros-ai/velaros'
import { createLocalShellHost } from '@velaros-ai/velaros/shell/local'
import { createTraceExporter, snapshot } from './trace-export.mjs'
import { discoverProjectCommands } from './tool-discovery.mjs'

// 这是正式 Runtime 的无人值守宿主；任务正文直接来自 Harbor，验收由 Harbor 在运行结束后执行。
export async function runTask({
  instruction,
  workspace,
  output,
  model,
  identity,
  turns = 256,
  timeoutMs = 3600000,
  isolatedContainer = false,
}) {
  await mkdir(output, { recursive: true })
  const host = createLocalShellHost({ cwd: workspace })
  let discovery
  let shellInspection
  const inspect = async () => {
    discovery = await discoverProjectCommands(workspace)
    shellInspection = await host.inspectEnvironment(discovery.commands)
  }
  const denied = async () => {
    throw new Error('Interactive approval is unavailable in this benchmark run')
  }
  const shell = createShellCapabilityModule({
    instanceId: 'harbor-shell',
    approval: {
      awaitConfirmation: isolatedContainer ? async () => {} : denied,
      awaitConfirmationDecision: async () => ({
        approved: isolatedContainer,
        message: isolatedContainer
          ? 'Authorized disposable task container'
          : 'Unattended benchmark',
      }),
    },
    shell: {
      resolveCwd: async (cwd) => host.resolvePath(cwd),
      commandPolicy: (cwd) => ({
        scopeLabel: cwd ?? workspace,
        riskScope: 'system-command:dangerous',
      }),
      runCommand: host.runCommand.bind(host),
      runObservationCommand: host.runObservationCommand?.bind(host),
      listBackgroundTasks: host.listBackgroundTasks.bind(host),
      refreshShellEnvironment: async () => {
        const result = await host.refreshShellEnvironment()
        await inspect()
        return result
      },
      terminateBackgroundTask: host.terminateBackgroundTask.bind(host),
    },
  })
  let runtime,
    session,
    status = 'starting',
    failure = null
  const modelName = model.model ?? model.id
  let traceExporter
  const cancel = () => session?.cancel()
  process.on('SIGTERM', cancel)
  process.on('SIGINT', cancel)
  try {
    await inspect()
    runtime = await createRuntime({
      workspace,
      dataDir: join(output, 'state'),
      model,
      project: identity?.runtimeOptions?.project,
      modules: [shell],
      residentModules: identity?.runtimeOptions?.residentModules ?? [
        { module: 'velaros:project' },
        { module: 'velaros:shell' },
        ...(identity?.runtimeOptions?.project?.images ? [{ module: 'velaros:images' }] : []),
      ],
      memory: false,
      modelTools: { concurrency: 1 },
      protocol: identity?.runtimeOptions?.protocol,
      context: identity?.runtimeOptions?.context,
      environment: () => ({
        os: `${platform()} ${arch()}`,
        workspace,
        shell: JSON.stringify({
          path: shellInspection.shell.path,
          kind: shellInspection.shell.kind,
          version: shellInspection.shell.version,
          pathEntries: shellInspection.shell.pathEntries,
          commands: shellInspection.commands,
          commandDiscovery: discovery.coverage,
        }),
        shells: JSON.stringify(
          shellInspection.shells.map((shell) => ({
            kind: shell.kind,
            path: shell.shellPath,
            version: shell.version,
            readiness: shell.readiness,
          }))
        ),
      }),
      instructions:
        'Complete the task autonomously in this isolated environment. Inspect the project, make the necessary changes, and verify the result using its normal development tools. No user is available for follow-up questions. Preserve unrelated files. Do not inspect hidden evaluation tests, solutions, reward files, or benchmark infrastructure. Use execute for shell commands; observe can read project files.',
      limits: { turns, timeoutMs, outputTokens: 32768, safetyTokens: 2048 },
    })
    session = await runtime.openSession(`harbor-task-${randomUUID()}`)
    traceExporter = createTraceExporter({
      trace: (query) => runtime.trace(session.id, query),
      output,
      sessionId: session.id,
      instruction,
      identity,
      model: modelName,
    })
    for await (const event of session.submit(instruction)) {
      await appendFile(join(output, 'events.jsonl'), JSON.stringify(event) + '\n')
      if (event.type === 'state') {
        status = event.status
        if (status === 'completed') failure = null
      }
      if (event.type === 'error') failure = event.message
      if (event.type === 'interaction') {
        failure = 'Agent requested unavailable human input'
        session.cancel()
      }
      if (event.type === 'turn') await traceExporter.export({ status, failure })
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
    status = 'failed'
    session?.cancel()
  } finally {
    try {
      // Settle cancellation and foreground receipts before the authoritative
      // snapshot; runtime storage remains readable until runtime.close().
      try {
        await session?.close()
      } catch (error) {
        failure ??= error instanceof Error ? error.message : String(error)
        status = 'failed'
      }
      if (traceExporter) await traceExporter.export({ final: true, status, failure })
      else await snapshot(join(output, 'status.json'), { status, failure })
    } finally {
      await runtime?.close()
      await host.dispose()
      process.off('SIGTERM', cancel)
      process.off('SIGINT', cancel)
    }
  }
  return { status, failure }
}

// 模型参数从候选身份读取，避免适配器标记与真实请求分叉。
export function candidateModel(identity, credentials) {
  if (
    typeof identity.modelName !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u.test(identity.modelName) ||
    !['low', 'medium', 'high'].includes(identity.reasoningEffort)
  )
    throw new Error('Candidate model and reasoning effort must be explicitly frozen')
  if (
    identity.openaiExplicitCacheBreakpoints !== undefined &&
    typeof identity.openaiExplicitCacheBreakpoints !== 'boolean'
  )
    throw new Error('Candidate OpenAI cache breakpoint capability must be boolean')
  return {
    provider: 'openai',
    model: identity.modelName,
    apiKey: credentials.apiKey,
    baseURL: credentials.baseURL,
    reasoningLevel: identity.reasoningEffort,
    ...(identity.openaiExplicitCacheBreakpoints === undefined
      ? {}
      : { openaiExplicitCacheBreakpoints: identity.openaiExplicitCacheBreakpoints }),
    limits: { contextTokens: 1050000, inputTokens: 922000, outputTokens: 32768 },
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      instruction: { type: 'string' },
      output: { type: 'string' },
      workspace: { type: 'string' },
    },
  })
  if (!values.instruction || !values.output)
    throw new Error('--instruction and --output are required')
  if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_BASE_URL)
    throw new Error('Budgeted OpenAI endpoint is required')
  if (platform() !== 'linux' || process.env.VELAROS_BENCH_CONTAINER !== '1')
    throw new Error('The benchmark CLI requires an isolated Linux task container')
  await access('/.dockerenv')
  const identity = JSON.parse(await readFile(new URL('./identity.json', import.meta.url), 'utf8'))
  const result = await runTask({
    instruction: await readFile(values.instruction, 'utf8'),
    workspace: resolve(values.workspace ?? process.cwd()),
    output: resolve(values.output),
    identity,
    isolatedContainer: true,
    model: candidateModel(identity, {
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL,
    }),
  })
  console.log(JSON.stringify(result))
  process.exitCode = result.status === 'completed' ? 0 : 1
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
