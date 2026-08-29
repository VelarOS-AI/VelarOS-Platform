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
    assert.match(control, /gitCompactSearchSlot[\s\S]*<SearchField[\s\S]*gitCompactFetchButton/)
    assert.doesNotMatch(control, /gitCompactSearchIcon|gitCompactInput/)
    assert.match(
      control,
      /gitCompactBranchList[\s\S]*gitCompactFooter[\s\S]*branchCreate/
    )
    assert.doesNotMatch(control, /updateAction|onUpdate|gitCompactActionDivider/)
    assert.match(control, /gitCompactBranchHoverActions[\s\S]*checkoutAction[\s\S]*uploadAction/)
    assert.match(control, /onUpload\(branch\)/)
    assert.match(control, /--workspace-git-theme-color/)
    assert.match(control, /<Dialog[\s\S]*createDialogTitle/)
    assert.match(control, /useState\(true\)/)
    assert.match(control, /checked=\{checkoutCreatedBranch\}/)
    assert.match(styles, /\.gitCompactMenu[\s\S]*background-color:[^;]+!important/)
    assert.match(styles, /\.gitCompactMenuHeader[\s\S]*padding:\s*3\.5px 4px/)
    assert.match(styles, /\.gitCompactFooter[\s\S]*padding:\s*2\.5px 3px 3px/)
    assert.match(styles, /\.gitCreateBranchDialog[\s\S]*max-width:\s*min\(320px/)
    assert.match(
      styles,
      /\.gitCompactSearchSlot :global\(\.velar-search-field-input\)[\s\S]*font-size:\s*11px/
    )
    assert.match(styles, /\.gitCompactBranchRow\[data-current='true'\][\s\S]*workspace-git-theme-color/)
    assert.match(styles, /\.gitCompactBranchRow:hover \.gitCompactBranchHoverActions[\s\S]*opacity:\s*1/)
  })
})
