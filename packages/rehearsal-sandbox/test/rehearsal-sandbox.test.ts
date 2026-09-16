/** 实现细节测试：路径规整与筛选。 */

import { describe, expect, test } from 'bun:test'

import { rehearsalSandboxRules } from '../src/index'

describe('按路径筛三列', () => {
  test('反斜杠当 /、开头的 ./ 去掉；不点名就全部；点名了没有的放 unknown', () => {
    expect(rehearsalSandboxRules.select({ created: ['a'], modified: ['b'], deleted: ['c'] }, ['./b', 'zzz'])).toEqual({ created: [], modified: ['b'], deleted: [], unknown: ['zzz'] })
    expect(rehearsalSandboxRules.select({ created: ['dir/a'], modified: [], deleted: [] }, ['dir\\a'])).toEqual({ created: ['dir/a'], modified: [], deleted: [], unknown: [] })
    expect(rehearsalSandboxRules.select({ created: ['a'], modified: ['b'], deleted: ['c'] }, undefined)).toEqual({ created: ['a'], modified: ['b'], deleted: ['c'], unknown: [] })
  })
})
