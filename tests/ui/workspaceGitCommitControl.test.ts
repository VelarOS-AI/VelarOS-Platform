import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

void describe('WorkspaceGitCommitControl ownership', () => {
  void test('keeps the mature branch menu and create dialog in one shared component', () => {
    const control = readSource(
      'packages/ui/src/product/git/WorkspaceGitCommitControl.tsx'
    )
    const styles = readSource(
      'packages/ui/src/product/git/WorkspaceGitCommitControl.module.css'
    )

    assert.match(control, /buildBranchTrie\(branches, namespace\)/)
    assert.match(control, /<FolderIcon[\s\S]*gitCompactBranchTreeFolder/)
    assert.match(control, /runRemoteAction\('fetch'\)/)
    assert.match(
      control,
      /updateAction[\s\S]*commitAction[\s\S]*uploadAction[\s\S]*gitCompactActionDivider[\s\S]*branchCreate/
    )
    assert.match(control, /<Dialog[\s\S]*createDialogTitle/)
    assert.match(control, /useState\(true\)/)
    assert.match(control, /checked=\{checkoutCreatedBranch\}/)
    assert.match(styles, /\.gitCompactMenu[\s\S]*background-color:[^;]+!important/)
    assert.match(styles, /\.gitCreateBranchDialog[\s\S]*max-width:\s*min\(320px/)
    assert.match(styles, /\.gitCompactInput:focus-visible[\s\S]*background-color:\s*transparent/)
  })
})
