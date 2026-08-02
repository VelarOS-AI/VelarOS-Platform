import { describe, expect, test } from 'bun:test'

import {
  readRawString,
  readRawStringScalar,
  readString,
} from '../src/utils/unknownJsonRecord'

describe('unknown JSON string readers', () => {
  test('keeps normalized and raw string semantics separate', () => {
    const record: Record<string, unknown> = {
      text: '  hello  ',
      whitespace: '   ',
      empty: '',
      other: 42,
    }

    expect(readString(record, 'text')).toBe('hello')
    expect(readString(record, 'whitespace')).toBeNull()
    expect(readRawString(record, 'text')).toBe('  hello  ')
    expect(readRawString(record, 'whitespace')).toBe('   ')
    expect(readRawString(record, 'empty')).toBe('')
    expect(readRawString(record, 'other')).toBeNull()
    expect(readRawStringScalar(' delta ')).toBe(' delta ')
  })
})
