// 整体发布的入口、声明和动态加载重定位回归。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { relocatePlatformText } from './unified-platform-package.mjs'

test('rewrites static, dynamic, require and declaration references without prefix collisions', () => {
  for (const text of [
    "import x from '@velaros-ai/core/error'",
    "import('@velaros-ai/model')",
    "require.resolve('@velaros-ai/kernel')",
    'import("@velaros-ai/agent").Agent',
    "const code = `import('@velaros-ai/script')`",
    '"@velaros-ai/context/contracts"',
  ]) {
    const expected = text.replace('@velaros-ai/', '@velaros-ai/velaros/')
    assert.equal(relocatePlatformText(text), expected)
  }
  assert.equal(relocatePlatformText('@velaros-ai/core-extra'), '@velaros-ai/core-extra')
  assert.equal(relocatePlatformText('@velaros-ai/skill-jsts'), '@velaros-ai/skill-jsts')
  assert.equal(
    relocatePlatformText('@velaros-ai/skill-jsts/package.json'),
    '@velaros-ai/velaros/skill-jsts/package.json'
  )
})
