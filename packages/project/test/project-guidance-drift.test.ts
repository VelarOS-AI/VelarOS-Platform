import { readFile } from 'node:fs/promises'

import { expect, test } from 'bun:test'
import { z } from 'zod'

import { assertGuidanceReviewed, collectGuidanceReview, ProjectGuidanceReviewPath, registeredGuidanceTools, validateGuidanceExamples } from '../scripts/model-guidance-audit'
import { projectTools } from '../src/agent/Project.tool'

const tools = registeredGuidanceTools(Object.values(projectTools))

test('static tool guidance cannot restore a discovery requirement missing from readonly roles', () => {
  const changed = tools.map((tool) => tool.name === 'project:search'
    ? { ...tool, description: `${tool.description}\nDiscover and load project:code through tooling:map and tooling:replace.` } : tool)
  expect(() => validateGuidanceExamples(changed)).toThrow('role-dependent discovery tools')
})

test('release gate binds current registered schemas, descriptions, examples and assembled prompt families to their explicit review', async () => {
  const actual = await collectGuidanceReview()
  expect(actual.toolNames).toHaveLength(8)
  expect(actual.matrixCases).toBe(192)
  const reviewed = JSON.parse(await readFile(ProjectGuidanceReviewPath, 'utf8'))
  expect(() => assertGuidanceReviewed(actual, reviewed)).not.toThrow()
})

test('a new required input rejects stale examples before a review fingerprint can be produced', () => {
  const changed = tools.map((tool) => tool.name === 'project:edit'
    ? { ...tool, schema: z.intersection(tool.schema, z.object({ newRequiredInput: z.string() })) } : tool)
  expect(() => validateGuidanceExamples(changed)).toThrow('example rejected by current schema')
})

test('an operation rename rejects its previously reviewed example', () => {
  const changed = tools.map((tool) => tool.name === 'project:edit'
    ? { ...tool, schema: z.object({ files: z.array(z.object({ fileRef: z.string(), edits: z.array(z.object({ op: z.literal('renamed-replace') })) })) }) } : tool)
  expect(() => validateGuidanceExamples(changed)).toThrow('example rejected by current schema')
})

test('even compatible schema descriptions and synchronized new examples require explicit guidance review', async () => {
  const reviewed = await collectGuidanceReview()
  const changedDescription = tools.map((tool) => tool.name === 'project:edit' ? { ...tool, schema: tool.schema.describe('Changed model-facing semantics') } : tool)
  expect(() => validateGuidanceExamples(changedDescription)).not.toThrow()
  const changed = await collectGuidanceReview(changedDescription)
  expect(() => assertGuidanceReviewed(changed, reviewed)).toThrow('Project model guidance changed')
  const newExample = { newRequiredInput: 'value' }
  const updated = tools.map((tool) => tool.name === 'project:edit'
    ? { ...tool, schema: z.object({ newRequiredInput: z.string() }), examples: [newExample], description: `调用参数示例：${JSON.stringify(newExample)}。` } : tool)
  expect(() => validateGuidanceExamples(updated)).not.toThrow()
  const updatedReview = await collectGuidanceReview(updated)
  expect(() => assertGuidanceReviewed(updatedReview, reviewed)).toThrow('Project model guidance changed')
})
