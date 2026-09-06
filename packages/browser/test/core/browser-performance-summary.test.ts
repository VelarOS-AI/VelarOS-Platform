import assert from 'node:assert/strict'

import { test } from 'bun:test'

import { extractKeyMetricsFromSummary } from '../../src/core/BrowserPerformanceOrchestrator.js'

void test('performance summary accepts legacy spacing without including nested metrics or suffix details', () => {
  const summary = [
    '##insight set id: set-a',
    '  -LCP: 2.5s,event: navigation',
    '  - CLS: 0.1,   nodeId: 42',
    '    - TTFB: nested',
    '##   insight set id: set-b',
    '  - INP: 120ms,bounds: [0,0]',
  ].join('\n')

  assert.equal(extractKeyMetricsFromSummary(summary), 'set-a: LCP 2.5s, CLS 0.1 | set-b: INP 120ms')
})
