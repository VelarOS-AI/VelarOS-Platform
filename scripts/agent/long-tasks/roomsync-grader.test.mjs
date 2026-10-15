// 用途：在付费派发前验证交付评分器的文档组织、打包工具和类型消费边界；替身不用于功能得分。
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { runCapturedCommand } from './command-output.mjs'
import { readRoomDocument, roomJsonEditor } from './roomsync-ui-check.mjs'

const source = process.env.ROOMSYNC_WS_SOURCE
const grader = fileURLToPath(new URL('./test_roomsync_service.mjs', import.meta.url))
const api = `
exports.openStore = async () => ({close:async()=>{}});
exports.createServer = async () => ({url:'http://127.0.0.1:1',close:async()=>{}});
exports.RoomClient = class {async connect(){} async close(){} async submit(){return {revision:1}}};
`
const declaration = `
export function openStore(directory:string,options?:{maxDocumentBytes?:number}):Promise<{snapshot(room:string):Promise<{revision:number}>;transact(room:string,transaction:{clientId:string;requestId:string;expectedRevision:number;operations:Array<{op:'put';key:string;value:unknown}>}):Promise<unknown>;close():Promise<void>}>;
export function createServer(options:{store:Awaited<ReturnType<typeof openStore>>;tokens:{read:string;write:string;admin:string}}):Promise<{url:string;close():Promise<void>}>;
export class RoomClient {constructor(options:{url:string;token:string;room:string;clientId:string});connect():Promise<void>;close():Promise<void>}
`

async function fixture(t) {
  assert(source, 'Set ROOMSYNC_WS_SOURCE to the untouched frozen ws source with installed tools')
  const root = await mkdtemp(join(tmpdir(), 'roomsync-grader-control-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await cp(resolve(source), root, {
    recursive: true,
    filter: (path) => !path.split('/').some((part) => ['node_modules', '.git'].includes(part)),
  })
  await symlink(join(resolve(source), 'node_modules'), join(root, 'node_modules'))
  const product = join(root, 'contrib/roomsync')
  for (const directory of ['docs', 'test/nested', 'examples'])
    await mkdir(join(product, directory), { recursive: true })
  await writeFile(join(product, 'index.js'), api)
  await writeFile(
    join(product, 'index.mjs'),
    "import api from './index.js';export const {openStore,createServer,RoomClient}=api;\n"
  )
  await writeFile(join(product, 'index.d.ts'), declaration)
  await writeFile(
    join(product, 'package.json'),
    JSON.stringify({
      name: 'roomsync-grader-control',
      version: '1.0.0',
      main: 'index.js',
      types: 'index.d.ts',
      exports: { '.': { types: './index.d.ts', import: './index.mjs', require: './index.js' } },
      dependencies: { ws: '^8.22.0' },
    })
  )
  await writeFile(join(product, 'README.md'), '# RoomSync\nSee [operations](docs/operations.md).\n')
  await writeFile(
    join(product, 'docs/operations.md'),
    'openStore and RoomClient; SIGKILL recovery, archive transfer and conflict resolution.\n'
  )
  await writeFile(
    join(product, 'test/nested/contract.test.mjs'),
    '// Only a grading control, not product evidence.\n'
  )
  await writeFile(join(product, 'examples/offline-demo.js'), 'console.log("example executed")\n')
  return { root, product }
}

async function grade(root, pattern) {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  return runCapturedCommand(
    process.execPath,
    ['--test', '--test-reporter=tap', `--test-name-pattern=${pattern}`, grader],
    { cwd: root, env, timeout: 90000 }
  )
}

test('delivery accepts linked operation guides and nested tests, but rejects a failing example', async (t) => {
  const f = await fixture(t)
  const positive = await grade(f.root, '^delivery contains')
  assert.equal(positive.exitCode, 0, positive.stdout + positive.stderr)
  await writeFile(join(f.product, 'README.md'), '# RoomSync\nSee [operations](OPERATIONS.md).\n')
  await writeFile(
    join(f.product, 'OPERATIONS.md'),
    'openStore and RoomClient; crash recovery, archive transfer and conflict resolution.\n'
  )
  await rm(join(f.product, 'docs'), { recursive: true })
  const rootGuide = await grade(f.root, '^delivery contains')
  assert.equal(rootGuide.exitCode, 0, rootGuide.stdout + rootGuide.stderr)
  await writeFile(join(f.product, 'examples/offline-demo.js'), 'process.exitCode=1\n')
  const negative = await grade(f.root, '^delivery contains')
  assert.equal(negative.exitCode, 1, negative.stdout + negative.stderr)
  assert.match(negative.stdout, /# fail 1/u)
})

test('packing accepts complete CJS/ESM/types and rejects missing ESM output', async (t) => {
  const f = await fixture(t)
  const positive = await grade(f.root, '^packed CJS')
  assert.equal(positive.exitCode, 0, positive.stdout + positive.stderr)
  await rm(join(f.product, 'index.mjs'))
  const negative = await grade(f.root, '^packed CJS')
  assert.equal(negative.exitCode, 1, negative.stdout + negative.stderr)
  assert.match(negative.stdout, /ERR_MODULE_NOT_FOUND/u)
})

test('packing rejects a public revision type incompatible with the consumer contract', async (t) => {
  const f = await fixture(t)
  await writeFile(
    join(f.product, 'index.d.ts'),
    (await readFile(join(f.product, 'index.d.ts'), 'utf8')).replace(
      'revision:number',
      'revision:string'
    )
  )
  const negative = await grade(f.root, '^packed CJS')
  assert.equal(negative.exitCode, 1, negative.stdout + negative.stderr)
  assert.match(negative.stdout, /not assignable to type/u)
})

test('UI checks accept accessible implicit labels and stored content in an editor or text panel', async (t) => {
  assert(source, 'Set ROOMSYNC_WS_SOURCE to the frozen source with installed browser tools')
  const require = createRequire(join(resolve(source), 'package.json'))
  const browser = await require('@playwright/test').chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  const key = '<img src=x onerror=alert(42)>'
  const text = '<script>alert(43)</script>'
  for (const presentation of ['editor', 'panel', 'combined-row']) {
    await page.setContent(
      '<label>JSON value<textarea>{}</textarea></label><button id="doc"></button><pre id="panel"></pre>'
    )
    assert.equal(await page.getByLabel('JSON value', { exact: true }).count(), 0)
    assert.equal(await roomJsonEditor(page).count(), 1)
    await page.evaluate(
      ({ key, text, presentation }) => {
        const doc = document.getElementById('doc')
        doc.textContent = presentation === 'combined-row' ? `${key}\n${text}` : key
        doc.onclick = () => {
          if (presentation === 'editor')
            document.querySelector('textarea').value = JSON.stringify({ text })
          else document.getElementById('panel').textContent = text
        }
      },
      { key, text, presentation }
    )
    await readRoomDocument(page, key, text)
    assert.equal(await page.locator('img[onerror]').count(), 0)
  }
})

test('UI checks reject an incorrect accessible name and hidden or absent document contents', async (t) => {
  assert(source, 'Set ROOMSYNC_WS_SOURCE to the frozen source with installed browser tools')
  const require = createRequire(join(resolve(source), 'package.json'))
  const browser = await require('@playwright/test').chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.setContent('<label>Payload<textarea>{}</textarea></label>')
  assert.equal(await roomJsonEditor(page).count(), 0)
  await assert.rejects(roomJsonEditor(page).fill('{}', { timeout: 150 }), /Timeout/u)
  for (const hidden of [false, true]) {
    await page.setContent(
      '<label>JSON value<textarea>{}</textarea></label><button>stored-key</button><pre hidden></pre>'
    )
    if (hidden)
      await page.locator('pre').evaluate((element) => {
        element.textContent = 'stored-content'
      })
    await assert.rejects(
      readRoomDocument(page, 'stored-key', 'stored-content', 150),
      /not visibly rendered/u
    )
  }
})
