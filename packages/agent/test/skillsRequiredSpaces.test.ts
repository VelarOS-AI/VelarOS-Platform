import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { createSkillDefinition, SkillFileStore } from '../src'

describe('Skill 必填空间声明', () => {
  test('文件 Skill 缺失或给空 spaces 时不进入技能库', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-skill-spaces-'))
    const store = new SkillFileStore({ skillsDir: () => root })
    try {
      writeFileSync(join(root, 'missing.md'), '---\nname: Missing\n---\n# Missing\n')
      writeFileSync(join(root, 'empty.md'), '---\nname: Empty\nspaces: []\n---\n# Empty\n')
      writeFileSync(
        join(root, 'scoped.md'),
        '---\nname: Scoped\nspaces: [system, project]\n---\n# Scoped\n'
      )

      expect(store.list().map((record) => record.id)).toEqual(['scoped'])
      expect(store.get('scoped')?.spaces).toEqual(['system', 'project'])
      expect(() => store.saveContent('---\nname: Missing\n---\n# Missing\n')).toThrow(
        'skill-frontmatter-spaces-missing'
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('编程式 Skill 定义同样拒绝空 capabilityScopes', () => {
    expect(() =>
      createSkillDefinition({
        id: 'missing-scope',
        label: 'Missing scope',
        provider: { id: 'test', kind: 'builtin' },
        roleIds: ['chat'],
        markdown: '# Missing scope',
        capabilityScopes: [],
      })
    ).toThrow('必须显式声明至少一个 capabilityScopes')
  })
})
