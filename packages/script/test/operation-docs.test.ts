import { expect, test } from 'bun:test'
import ts from 'typescript'

import { createModuleExportSlicer } from '../src/utils/compiler'
import { nodeOperationDeclarations } from '../src/utils/node-client'

test('单操作文档保留注释和递归类型闭包，隔离其他操作与示例参数', () => {
  const source = `/** 所有操作共享当前授权队列。 */
  declare module 'velaros:queue' {
    /** 读取当前队列。 */ export function list(): Promise<Item[]>;
    /** 写入队列。 */ export function save(input: Save): Promise<void>;
    interface Item { child?: Item; status: Status; }
    type Status = 'waiting' | 'done';
    interface Save { secret: string; }
  }`
  const docs = nodeOperationDeclarations(source, 'velaros:queue', ['list', 'save'])
  expect(docs.list).toContain('读取当前队列')
  expect(docs.list).toContain('interface Item')
  expect(docs.list).toContain('type Status')
  expect(docs.list).toContain('capability["list"]()')
  expect(docs.list).not.toContain('interface Save')
  expect(docs.list).not.toContain('function save')
  expect(docs.save).toContain('interface Save')
  expect(docs.save).not.toContain('interface Item')
  expect(docs.save).toContain('所有操作共享当前授权队列')
  const file = ts.createSourceFile('list.d.ts', docs.list!, ts.ScriptTarget.Latest, true)
  expect(file.statements.some((statement) => ts.isFunctionDeclaration(statement))).toBe(true)
})

test('批量切片的类型闭包互不污染，空选择和缺失操作仍明确返回', () => {
  const source = `/** 本模块规则。 */
  declare module 'velaros:queue' {
    export function read(): Promise<Item>;
    export function write(input: Change): Promise<void>;
    export function write(input: Change, retry: number): Promise<void>;
    interface Item { nested?: Item; state: State; }
    type State = 'open' | 'closed';
    interface Change { text: string; }
  }`
  const slice = createModuleExportSlicer(source, 'velaros:queue')
  const read = slice(['read'])
  const write = slice(['write'])
  expect(read.declarations).toContain('interface Item')
  expect(read.declarations).not.toContain('interface Change')
  expect(write.declarations).toContain('retry: number')
  expect(write.declarations).toContain('interface Change')
  expect(write.declarations).not.toContain('interface Item')
  expect(slice(['read'])).toEqual(read)
  expect(slice([])).toEqual({ declarations: null, exports: ['read', 'write'], missing: [] })
  expect(slice(['absent'])).toEqual({
    declarations: null,
    exports: ['read', 'write'],
    missing: ['absent'],
  })
  expect(nodeOperationDeclarations(source, 'velaros:queue', ['read', 'absent'])).toHaveProperty(
    'read'
  )
  expect(
    Object.keys(nodeOperationDeclarations(source, 'velaros:queue', ['read', 'absent']))
  ).toEqual(['read'])
})
