#!/usr/bin/env bun
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const packageRoot = join(
  repositoryRoot,
  'node_modules/chrome-devtools-frontend',
)
const entrypoint = join(
  repositoryRoot,
  'scripts/browser/devtoolsPerformanceEngine.entry.ts',
)
const nodeHostRuntimePath = join(
  packageRoot,
  'front_end/core/platform/node/HostRuntime.ts',
)
const outputPath = join(
  repositoryRoot,
  'packages/browser/vendor/devtools-performance-engine/devtoolsPerformanceEngine.mjs',
)
const expectedUpstreamVersion = '1.0.1652307'
const embeddedGoogleApiKey = /\bAIza[0-9A-Za-z_-]{35}\b/g
const disabledGoogleApiKey = 'VELAROS_DISABLED_CRUX_API_KEY'
const checkOnly = process.argv.includes('--check')
const upstreamLegacyModuleLoader = `  loadLegacyModule(modulePath: string): Promise<unknown> {
    // eslint-disable-next-line no-console
    console.log('Loading legacy module: ' + modulePath);
    const importPath =
        \`../../\${modulePath}\`;  // Extracted as a variable so esbuild doesn't attempt to bundle all the things.
    return import(importPath).then(m => {
      // eslint-disable-next-line no-console
      console.log('Loaded legacy module: ' + modulePath);
      return m;
    });
  }`
const disabledLegacyModuleLoader = `  loadLegacyModule(modulePath: string): Promise<unknown> {
    return Promise.reject(new Error(
        \`Legacy DevTools module loading is unavailable in the VelarOS Node-only performance engine: \${modulePath}\`));
  }`
const dependencyStubs = {
  'velaros:devtools-node-host-runtime': [
    `export { HOST_RUNTIME } from ${JSON.stringify(nodeHostRuntimePath)}`,
    'export const IS_NODE = true',
    'export const IS_BROWSER = false',
  ].join('\n'),
  'velaros:devtools-locales': [
    "export const LOCALES = ['en-US']",
    "export const BUNDLED_LOCALES = ['en-US']",
    "export const DEFAULT_LOCALE = 'en-US'",
    "export const REMOTE_FETCH_PATTERN = ''",
    "export const LOCAL_FETCH_PATTERN = ''",
  ].join('\n'),
  'velaros:codemirror-next': [
    'export default {}',
    'export const cssStreamParser = () => Promise.resolve({ startState: () => ({}) })',
    'export class StringStream {}',
    'export const css = { cssLanguage: { parser: { parse: () => ({ topNode: { getChild: () => null } }) } } }',
  ].join('\n'),
}
const devtoolsStubPlugin = {
  name: 'velaros-devtools-node-stubs',
  setup(build) {
    build.onResolve({ filter: /^\.\/HostRuntime\.js$/ }, ({ importer }) => {
      if (importer.endsWith('/front_end/core/platform/platform.ts')) {
        return {
          path: 'velaros:devtools-node-host-runtime',
          namespace: 'velaros-stub',
        }
      }
      return undefined
    })
    build.onResolve({ filter: /^\.\/locales\.js$/ }, ({ importer }) => {
      if (importer.endsWith('/front_end/core/i18n/i18nImpl.ts')) {
        return { path: 'velaros:devtools-locales', namespace: 'velaros-stub' }
      }
      return undefined
    })
    build.onResolve({ filter: /codemirror\.next\.js$/ }, () => ({
      path: 'velaros:codemirror-next',
      namespace: 'velaros-stub',
    }))
    build.onLoad(
      { filter: /\/front_end\/core\/root\/Runtime\.ts$/ },
      async ({ path }) => {
        const source = await readFile(path, 'utf8')
        if (!source.includes(upstreamLegacyModuleLoader)) {
          throw new Error(
            'Upstream DevTools Runtime.loadLegacyModule shape changed; update the Node-only stub.',
          )
        }
        return {
          contents: source.replace(
            upstreamLegacyModuleLoader,
            disabledLegacyModuleLoader,
          ),
          loader: 'ts',
        }
      },
    )
    build.onLoad({ filter: /.*/, namespace: 'velaros-stub' }, ({ path }) => ({
      contents: dependencyStubs[path],
      loader: 'js',
    }))
  },
}

function assertDesktopMainEmbeddable(output) {
  const dynamicImportIndex = output.search(/\bimport\s*\(/)
  if (dynamicImportIndex !== -1) {
    const context = output.slice(
      Math.max(0, dynamicImportIndex - 120),
      dynamicImportIndex + 240,
    )
    throw new Error(
      `Bundled DevTools engine contains a dynamic import that Desktop CJS embedding cannot preserve: ${context}`,
    )
  }
  if (output.includes('Unknown runtime!')) {
    throw new Error(
      'Bundled DevTools engine retained the generic top-level-await host runtime instead of the Node runtime.',
    )
  }
}

const upstreamManifest = JSON.parse(
  await readFile(join(packageRoot, 'package.json'), 'utf8'),
)
if (upstreamManifest.version !== expectedUpstreamVersion) {
  throw new Error(
    `Expected chrome-devtools-frontend ${expectedUpstreamVersion}, received ${upstreamManifest.version}`,
  )
}

const temporaryDirectory = await mkdtemp(
  join(tmpdir(), 'velaros-devtools-engine-'),
)
try {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir: temporaryDirectory,
    naming: 'devtoolsPerformanceEngine.mjs',
    target: 'node',
    format: 'esm',
    // Syntax minification folds Root.Runtime's deliberately opaque `import(importPath)`
    // back into a template import. Desktop's esbuild pass then treats it as a glob and
    // tries to parse every file in @velaros-ai/browser. Keep identifiers/whitespace
    // minified while preserving the opaque expression until the Node-only stub removes it.
    minify: { identifiers: true, syntax: false, whitespace: true },
    sourcemap: 'none',
    plugins: [devtoolsStubPlugin],
    banner: [
      '// Generated by scripts/browser/buildDevtoolsPerformanceEngine.mjs. Do not edit.',
      '// Source: chrome-devtools-frontend@1.0.1652307 (BSD-3-Clause).',
      '// Integration entry adapted from chrome-devtools-mcp@2d944f9f4e6b107a6b42fb82c7e957384883bf7d (Apache-2.0).',
      '// See NOTICE.md and the adjacent license files.',
    ].join('\n'),
    throw: true,
  })
  if (!result.success || result.outputs.length !== 1) {
    throw new Error(
      `Unexpected Bun build result: ${result.outputs.length} output(s)`,
    )
  }

  const builtPath = result.outputs[0].path
  let output = await readFile(builtPath, 'utf8')
  const embeddedKeys = output.match(embeddedGoogleApiKey) ?? []
  if (embeddedKeys.length !== 1) {
    throw new Error(
      `Expected one upstream Google API key, found ${embeddedKeys.length}`,
    )
  }

  // VelarOS supplies an explicit device scope to the formatter and never uses
  // the bundled CrUX network client. Remove the upstream credential anyway so
  // this distributable cannot expose or accidentally exercise it.
  output = output.replace(embeddedGoogleApiKey, disabledGoogleApiKey)
  assertDesktopMainEmbeddable(output)

  if (checkOnly) {
    const committed = await readFile(outputPath, 'utf8')
    if (committed !== output) {
      throw new Error(
        'Bundled DevTools performance engine is stale. Run `bun run build:devtools-performance-engine`.',
      )
    }
    console.log('DevTools performance engine is reproducible and current.')
  } else {
    await writeFile(outputPath, output)
    console.log(
      'Generated packages/browser/vendor/devtools-performance-engine/devtoolsPerformanceEngine.mjs',
    )
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
}
