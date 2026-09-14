import { expect, test } from 'bun:test'

import { collectProjectSourceViews, projectSourceSegments } from '../src/conversation/tool-render/projectSource/projectSourceView'

test('source display finds nested result windows and never adds line labels to copy text', () => {
  const windows = collectProjectSourceViews({ result: { files: [{ kind: 'project-source-window', path: 'a.ts', lines: [[42, '123|literal'], [43, '  return "\\n🙂"'], [51, 'last']], fragments: [{ line: 60, columns: [10, 14], text: 'part' }] }] } })
  expect(windows).toHaveLength(1)
  const segments = projectSourceSegments(windows[0]!)
  expect(segments.map((segment) => segment.text)).toEqual(['123|literal\n  return "\\n🙂"', 'last', 'part'])
  expect(segments[2]?.fragment).toBe(true)
  expect(segments[2]?.label).toContain('60:10')
})

test('source presentation rejects malformed rows and handles circular UI data', () => {
  const value: any = { kind: 'project-source-window', path: 'a.ts', lines: [[0, 'bad'], [1, ''], [2, 123], [3, 'raw', 'extra']] }
  value.circular = value
  const windows = collectProjectSourceViews(value)
  expect(windows[0]!.lines).toEqual([[1, '']])
  expect(projectSourceSegments(windows[0]!)[0]!.text).toBe('')
})
