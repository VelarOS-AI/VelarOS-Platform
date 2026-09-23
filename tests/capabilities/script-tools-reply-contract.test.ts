/** 脚本结果保持原文，多模态编码由同一个 Kernel 请求编码器生成。 */
import { expect, test } from 'bun:test'

import { modelRequestEncoder } from '@velaros-ai/kernel'

import {
  codeProgramChecker,
  createCapabilityPort,
  createCodeSurfaceSession,
  nodeSubprocessCodeRunner,
  scriptPackageCompiler,
} from '../../packages/script/src/index'

test('ScriptAct 原始文本与图片作为独立材料进入同一模型编码', async () => {
  const text = JSON.stringify({
    note: '引号"反斜杠\\换行\n',
    lines: Array.from({ length: 400 }, (_, i) => `第 ${i} 行`),
  })
  const script = createCodeSurfaceSession({
    checker: codeProgramChecker,
    runner: nodeSubprocessCodeRunner,
    capabilities: createCapabilityPort({}),
  })
  const result = await script.submit({
    program: { source: `import {output} from 'velaros';output(${JSON.stringify(text)});` },
    granted: scriptPackageCompiler.compile([], []).granted,
  })
  expect(result.checked).toBe(true)
  if (!result.checked) throw Error('script failed validation')
  expect(result.result.failed).toBeUndefined()
  expect(result.result.value.default).toBe(text)
  const image = {
    type: 'image-data' as const,
    mediaType: 'image/png',
    data: 'aW1hZ2U=',
    origin: 'capability' as const,
    label: '结果图片',
  }
  const encoded = modelRequestEncoder.messages({
    instructions: 'Inspect',
    materials: [{ ref: 'result', text, origin: 'script', totalChars: text.length }],
    images: [image],
    response: { type: 'text' },
    mode: 'work',
    outputTokens: 1024,
  })
  const message = encoded.at(-1)!
  if (message.role !== 'user' || typeof message.content === 'string')
    throw Error('expected multimodal user content')
  const part = message.content[0]
  if (part.type !== 'text') throw Error('expected material text')
  const material = JSON.parse(part.text.slice(part.text.indexOf('\n') + 1))
  expect(material[0].text).toBe(text)
  expect(message.content.at(-1)).toMatchObject({
    type: 'image',
    image: 'data:image/png;base64,aW1hZ2U=',
    mediaType: 'image/png',
  })
})
