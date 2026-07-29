# Component Library Registry

The component library is assembled by Vite glob discovery. Do not add new
entries to `LibraryRegistry.tsx` by hand.

## Add A Component Entry

Create a file under `registry/entries/<section>/<component>.entry.tsx`:

```tsx
import { defineComponentLibraryEntry } from '../../componentLibraryRegistryTypes'
import { componentLibraryRegistrySections } from '../../componentLibraryRegistrySections'
import documentation from './MyComponent.md?raw'

export default defineComponentLibraryEntry({
  ...componentLibraryRegistrySections.foundation,
  entryOrder: 40,
  entry: {
    id: 'my-component',
    name: 'MyComponent',
    layer: 'UI',
    status: 'ready',
    domain: 'Main window',
    source: '@velaros-ai/ui',
    usage: 'Use for ...',
    avoid: 'Avoid ...',
    apiComponents: ['MyComponent'],
    documentation,
    examples: [],
  },
})
```

`apiComponents` is the strong link to TypeScript props. `bun run component-library:api`
scans exported component props and refreshes the generated API rows before
the component catalog build and verification.

`bun run component-library:docs` compares changed public component source files
against Git and warns when the matching entry, imported Markdown docs,
example/interactive demo fixture, or generated API rows did not change with them.
Use `COMPONENT_LIBRARY_DOCS_BASE=<ref>` or `--base <ref>` when a CI job should
compare the branch against a specific base instead of local `HEAD`. GitHub
Actions pull-request runs use `GITHUB_BASE_REF` automatically when the base ref
is available locally.

Use `bun run check:component-library` to refresh the generated API and run the
freshness check together.

## Add A Whole Section

Create `registry/sections/<name>.section.tsx` and export a section or section
group with `defineComponentLibrarySection` / `defineComponentLibrarySectionGroup`.

For the normal one-entry-per-file path, keep section id/title/order in
`componentLibraryRegistrySections.ts`, then spread the matching section binding
inside each `*.entry.tsx` module.
