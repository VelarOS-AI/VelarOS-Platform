// 同一 Runtime 的实验动作适配：逐工具调用机械翻译成一次独立操作，不替模型规划或计算。
import assert from 'node:assert/strict'

const object = (properties, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})
const string = { type: 'string' }
export const operationTools = [
  {
    name: 'readFile',
    description:
      'Read the complete UTF-8 file at path. Paths are relative to the workspace or absolute.',
    schema: object({ path: string }),
  },
  {
    name: 'writeFile',
    description:
      'Write complete UTF-8 content to path, creating parent directories. Returns the byte count.',
    schema: object({ path: string, content: string }),
  },
  {
    name: 'listFiles',
    description:
      'List immediate directory entries, their names and kinds. Does not recursively follow links.',
    schema: object({ path: string }),
  },
  {
    name: 'runCommand',
    description:
      'Run a shell command in the workspace. Supports scripts, pipelines, batching and parallel shell jobs. Returns stdout, stderr and exit code. Timeout is 60 seconds; each output is bounded at 2 MB.',
    schema: object({ command: string }),
  },
]

export function operationProgram(call) {
  const value = call.input
  assert(
    value && typeof value === 'object' && !Array.isArray(value),
    'Tool input must be an object'
  )
  const tool = operationTools.find((item) => item.name === call.name)
  assert(tool && Object.keys(value).length === tool.schema.required.length)
  for (const name of tool.schema.required) assert(typeof value[name] === 'string')
  const literal = JSON.stringify(value)
  const start = `const input=${literal};\n`
  if (call.name === 'readFile')
    return (
      start +
      `import {readFile} from 'node:fs/promises'; console.log(await readFile(input.path,'utf8'));`
    )
  if (call.name === 'writeFile')
    return (
      start +
      `import {mkdir,writeFile} from 'node:fs/promises'; import {dirname} from 'node:path'; await mkdir(dirname(input.path),{recursive:true}); await writeFile(input.path,input.content); console.log(JSON.stringify({bytes:Buffer.byteLength(input.content)}));`
    )
  if (call.name === 'listFiles')
    return (
      start +
      `import {readdir} from 'node:fs/promises'; console.log(JSON.stringify((await readdir(input.path,{withFileTypes:true})).map(x=>({name:x.name,kind:x.isDirectory()?'directory':x.isSymbolicLink()?'link':'file'}))));`
    )
  return (
    start +
    `import {execFile} from 'node:child_process'; const result=await new Promise(resolve=>execFile('/bin/sh',['-c',input.command],{timeout:60000,maxBuffer:2000000},(error,stdout,stderr)=>resolve({exitCode:error?.code??0,signal:error?.signal??null,stdout,stderr})));console.log(JSON.stringify(result));`
  )
}

export function actionAdapter(driver, mode) {
  assert(['script', 'tools'].includes(mode))
  const calls = new Map()
  function prepare(request) {
    if (
      mode === 'script' ||
      request.response.type !== 'tools' ||
      !request.response.tools.some((tool) => tool.name === 'exec')
    )
      return request
    const history = request.history?.map((message) => {
      if (message.role === 'assistant' && message.toolExchange)
        return {
          ...message,
          toolExchange: {
            ...message.toolExchange,
            calls: message.toolExchange.calls.map((call) => calls.get(call.id) ?? call),
            results: message.toolExchange.results.map((result) => ({
              ...result,
              name: calls.get(result.id)?.name ?? result.name,
            })),
          },
        }
      if (message.role === 'user' && message.toolResult)
        return {
          ...message,
          toolResult: {
            ...message.toolResult,
            toolName: calls.get(message.toolResult.callId)?.name ?? message.toolResult.toolName,
          },
        }
      return message
    })
    return {
      ...request,
      history,
      instructions:
        request.instructions +
        '\nThis session uses the individual-tools experimental interface. Submit actions only through the advertised readFile, writeFile, listFiles, runCommand and done tools. Runtime history may contain mechanically generated JavaScript wrappers; those are host audit records. runCommand permits the same workspace shell, batching, computation and concurrency as the script interface. Multiple independent tools may be submitted in one response. Finish with done after checking the current original requirements and actual artifacts.',
      response: {
        type: 'tools',
        tools: [
          ...operationTools,
          ...request.response.tools.filter((tool) => tool.name === 'done'),
        ],
      },
    }
  }
  return {
    id: driver.id,
    nativeTools: true,
    limits: driver.limits,
    estimate: (request) => driver.estimate(prepare(request)),
    async *stream(request, signal) {
      const transformed = prepare(request)
      for await (const delta of driver.stream(transformed, signal)) {
        if (
          mode === 'tools' &&
          transformed !== request &&
          delta.type === 'tool-call' &&
          delta.value.name !== 'done'
        ) {
          calls.set(delta.value.id, delta.value)
          yield {
            ...delta,
            value: {
              id: delta.value.id,
              name: 'exec',
              input: { code: operationProgram(delta.value) },
            },
          }
        } else yield delta
      }
    },
  }
}
