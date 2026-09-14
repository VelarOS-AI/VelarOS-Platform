import { describe, expect, test } from 'bun:test'

import { InMemoryContextPayloadStore } from '../src/agent/context/ContextPayloadStore'
import {
  ContextPayloadKernelToolOutputStore,
  InMemoryKernelToolOutputStore,
} from '../src/kernel/tool-output-store'

function window(path: string, lines: number) {
  return {
    kind: 'project-source-window',
    path,
    revision: 'r1',
    viewSource: `source:${'a'.repeat(64)}`,
    lines: Array.from({ length: lines }, (_, index) => [index + 1, `const value_${index} = "中文🙂 \\n literal"`]),
  }
}

const batchRead = { rootPath: '/repo', count: 3, files: ['a.ts', 'b.ts', 'c.ts'].map((path) => window(path, 400)) }

describe('tool output store keeps source windows structured', () => {
  test.each(['memory', 'payload'])(
    'a batch read over the projection budget stays complete JSON with continuations (%s)',
    async (kind) => {
      const store =
        kind === 'memory'
          ? new InMemoryKernelToolOutputStore({ projectionChars: 6000 })
          : new ContextPayloadKernelToolOutputStore(new InMemoryContextPayloadStore(), { projectionChars: 6000 })
      const full = JSON.stringify(batchRead)
      expect(full.length).toBeGreaterThan(6000)
      const projected = await store.project({ sessionId: 's', toolCallId: 'read-1', toolName: 'project:read', output: batchRead })
      const serialized = JSON.stringify(projected.output)
      expect(serialized.length).toBeLessThanOrEqual(6000)
      expect(serialized).not.toContain('__contextRef')
      const output = projected.output as { files: any[] }
      expect(output.files.map((file) => file.path)).toEqual(['a.ts', 'b.ts', 'c.ts'])
      for (const file of output.files) {
        expect(file.kind).toBe('project-source-window')
        expect(file.lines.length).toBeGreaterThan(0)
        expect(file.lines[0]).toEqual([1, 'const value_0 = "中文🙂 \\n literal"'])
        expect(file.hasMore).toBe(true)
        expect(file.truncated).toBe(true)
        expect(file.continuation.range.startLine).toBe(file.lines.at(-1)[0] + 1)
        expect(file.viewSource).toStartWith('source:')
      }
      // 完整输出照常归档，召回仍拿得到全部行。
      expect(projected.stored?.chars).toBe(full.length)
      expect(JSON.stringify(projected.stored?.output)).toBe(full)
    }
  )

  test('a source window result within the budget is returned untouched', () => {
    const store = new InMemoryKernelToolOutputStore({ projectionChars: 60_000 })
    const projected = store.project({ sessionId: 's', toolCallId: 'read-2', toolName: 'project:read', output: batchRead })
    expect(projected.output).toEqual(batchRead)
    expect(projected.stored).toBeNull()
  })

  test('outputs without source windows keep the head-tail envelope', () => {
    const store = new InMemoryKernelToolOutputStore({ projectionChars: 200 })
    const projected = store.project({
      sessionId: 's',
      toolCallId: 'list-1',
      toolName: 'project:list',
      output: { entries: Array.from({ length: 100 }, (_, index) => ({ path: `file-${index}.ts` })) },
    })
    expect((projected.output as { __contextRef?: string }).__contextRef).toBe('tool-output')
  })
})
