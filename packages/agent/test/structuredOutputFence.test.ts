import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import {
  compileSubAgentOutputSchema,
  parseSubAgentStructuredOutput,
} from '../src/sub-agent/StructuredOutput.js'

const compiled = compileSubAgentOutputSchema({
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: false,
})

void describe('sub-agent structured output fences', () => {
  for (const [label, output] of [
    ['single-line JSON', '```json {"ok":true}```'],
    ['single-line JSON without a separator', '```json{"ok":true}```'],
    ['multi-line JSON', '```json\n{"ok":true}\n```'],
    ['single-line Markdown', '```markdown {"ok":true}```'],
    ['multi-line Markdown', '```markdown\n{"ok":true}\n```'],
  ] as const) {
    void test(`accepts legacy ${label} fences`, () => {
      assert.deepEqual(parseSubAgentStructuredOutput(output, compiled), {
        success: true,
        data: { ok: true },
      })
    })
  }

  for (const [label, output, schema, expected] of [
    ['string', '```json"ready"```', { type: 'string' }, 'ready'],
    ['number', '```json123```', { type: 'number' }, 123],
    ['boolean', '```jsontrue```', { type: 'boolean' }, true],
    ['null', '```jsonnull```', { type: 'null' }, null],
  ] as const) {
    void test(`accepts a separator-free fenced JSON ${label}`, () => {
      const primitiveSchema = compileSubAgentOutputSchema(schema)
      assert.deepEqual(parseSubAgentStructuredOutput(output, primitiveSchema), {
        success: true,
        data: expected,
      })
    })
  }
})
