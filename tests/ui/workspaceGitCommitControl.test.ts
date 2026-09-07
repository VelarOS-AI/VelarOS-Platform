import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

function readStyleRules(styles: string): Array<{ selector: string; properties: string[] }> {
  return Array.from(styles.matchAll(/([^{}]+)\{([^{}]*)\}/g), ([, selector, declarations]) => ({
    selector: selector.trim(),
    properties: declarations.split(';').flatMap((declaration) => {
      const separator = declaration.indexOf(':')
      return separator < 0 ? [] : [declaration.slice(0, separator).trim()]
    }),
  }))
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

  void test('leaves shared control surfaces and dimensions independent of Git CSS load order', () => {
    const styles = readSource('packages/ui/src/product/git/WorkspaceGitCommitControl.module.css')
    const rules = readStyleRules(styles)
    const owners = [
      { selector: '.gitCompactControl', properties: ['min-width', '-webkit-app-region'] },
      { selector: '.gitCompactButton', properties: ['max-width'] },
      {
        selector: ".gitCompactMenu[data-slot='popover-content']",
        properties: ['width', 'min-width', 'max-width', 'overflow'],
      },
    ]

    for (const owner of owners) {
      const rule = rules.find(({ selector }) => selector === owner.selector)
      assert.ok(rule, `${owner.selector} retains its business layout boundary`)
      for (const property of rule.properties) {
        assert.ok(owner.properties.includes(property), `${owner.selector} must not own ${property}`)
      }
    }

    assert.doesNotMatch(styles, /\.gitCompactButton(?::|\[)/)
    assert.doesNotMatch(styles, /\.gitCompactAnchor\b/)
    assert.doesNotMatch(styles, /--git-compact-menu-bg|--control-gray-bg/)

    const searchRules = rules.filter(({ selector }) => selector.startsWith('.gitCompactSearchSlot'))
    assert.ok(searchRules.length > 0)
    for (const rule of searchRules) {
      for (const property of rule.properties) {
        assert.doesNotMatch(property, /^(?:border|background|box-shadow|outline)/)
      }
    }
    assert.doesNotMatch(styles, /:global\(\.velar-search-field(?::|\))/)
  })

  void test('keeps portal interaction and plain frame surfaces in shared foundations', () => {
    const popover = readSource('packages/ui/src/styles/components/primitives/popover.css')
    const product = readSource('packages/ui/src/styles/components/product.css')

    assert.match(popover, /\.velar-popover-content\s*\{[^}]*-webkit-app-region:\s*no-drag/)
    const productRules = readStyleRules(product)
    const panel = productRules.find(({ selector }) => selector.includes('.velar-topbar-control-panel'))
    assert.ok(panel)
    assert.ok(panel.properties.every((property) => !/^(?:background|border-color|box-shadow|padding)/.test(property)))

    for (const state of [':hover', ':active', '.velar-topbar-control-frame-busy']) {
      const rule = productRules.find(({ selector }) =>
        selector.includes(`.velar-topbar-control-frame-plain${state}`)
      )
      assert.ok(rule, `plain ${state} must retain its shared surface policy`)
      assert.ok(rule.properties.includes('background'))
    }
  })
})
