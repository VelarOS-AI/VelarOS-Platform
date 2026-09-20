import { platform } from 'node:process'

import { describe, expect, test } from 'bun:test'

import { matchesAny } from '../utils/glob'

/** 本机的盘区不区分大小写（macOS、Windows 不区分）。 */
const caseInsensitiveVolume = platform === 'darwin' || platform === 'win32'

describe('glob matching semantics', () => {
  test('preserves exact, directory-prefix, glob, dotfile, and normalized-path matching', () => {
    expect(matchesAny('src/index.ts', ['src/index.ts'])).toBe(true)
    expect(matchesAny('src/nested/index.ts', ['src'])).toBe(true)
    expect(matchesAny('dist/nested/app.js', ['dist/'])).toBe(true)
    expect(matchesAny('src/index.ts', ['src/*.ts'])).toBe(true)
    expect(matchesAny('src/nested/index.ts', ['src/*.ts'])).toBe(false)
    expect(matchesAny('.github/workflows/check.yml', ['**/*.yml'])).toBe(true)
    expect(matchesAny('src\\nested\\index.ts', ['src/**'])).toBe(true)
    expect(matchesAny('src/index.js', ['src/*.{ts,tsx}'])).toBe(false)
    expect(matchesAny('src/index.ts', [])).toBe(false)
  })

  test('大小写按盘的规矩：不区分大小写的盘上大小写变体命中同一条规则', () => {
    expect(matchesAny('.ENV', ['.env'])).toBe(caseInsensitiveVolume)
    expect(matchesAny('SRC/nested/index.ts', ['src/'])).toBe(caseInsensitiveVolume)
    expect(matchesAny('src/api.GENERATED.ts', ['**/*.generated.*'])).toBe(caseInsensitiveVolume)
    expect(matchesAny('PACKAGE.json', ['package.json'])).toBe(caseInsensitiveVolume)
    // 大小写一致时两种盘上都命中。
    expect(matchesAny('src/api.generated.ts', ['**/*.generated.*'])).toBe(true)
  })
})
