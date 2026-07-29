import type { ComponentLibraryEntry } from '../models/componentLibraryTypes'

function pascalToken(raw: string): string {
  return raw
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((value) => !!value)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join('')
}

export function getComponentDisplayName(entry: ComponentLibraryEntry): string {
  const slashNames = entry.name
    .split('/')
    .map((segment) => segment.trim())
    .filter((value) => !!value)

  if (slashNames.length > 1) return slashNames.map(pascalToken).join('')

  return pascalToken(slashNames[0] ?? entry.name) || 'Component'
}

export function getExampleImportNameList(entry: ComponentLibraryEntry): string[] {
  const slashNames = entry.name
    .split('/')
    .map((segment) => segment.trim())
    .filter((value) => !!value)

  if (slashNames.length > 1) return slashNames
      .map((segment) =>
        segment
          .replace(/[^a-zA-Z0-9]+/g, ' ')
          .trim()
          .split(' ')
          .filter((value) => !!value)
          .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
          .join('')
      )
      .filter((value) => !!value)

  return [getComponentDisplayName(entry) || 'Component']
}

export function getExampleImportNames(entry: ComponentLibraryEntry): string {
  return getExampleImportNameList(entry).join(', ')
}

export function getExampleImportPath(entry: ComponentLibraryEntry): string {
  return entry.source.startsWith('@') ? entry.source : `@/${entry.source}`
}

export function getImportCode(entry: ComponentLibraryEntry): string {
  return `import { ${getExampleImportNames(entry)} } from '${getExampleImportPath(entry)}'`
}

export function getExampleCode(entry: ComponentLibraryEntry, label: string, code?: string): string {
  if (code) return code.trim()

  const componentName = getComponentDisplayName(entry) || 'Component'
  const componentNames = getExampleImportNameList(entry)

  if (componentNames.length > 1) return [
      getImportCode(entry),
      '',
      `export function ${componentName}Example() {`,
      '  return (',
      '    <>',
      ...componentNames.map((name) => `      <${name} />`),
      '    </>',
      '  )',
      '}',
      '',
      `// ${label}`,
    ].join('\n')

  return [
    getImportCode(entry),
    '',
    `export function ${componentName}Example() {`,
    `  return <${componentName} />`,
    '}',
    '',
    `// ${label}`,
  ].join('\n')
}
