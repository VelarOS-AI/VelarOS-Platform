import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { nodeRuntimePackages } from '@velaros-ai/script'

import { createCapabilityModule, createRuntime } from '../../../dist/act/runtime/index.js'
import { frameEnvironment } from '../../../dist/act/runtime/utils/environment.js'
import { boundedInventory } from '../../../dist/act/runtime/utils/inventory.js'
import { runtimeInstructions } from '../../../dist/act/runtime/utils/model-instructions.js'
import { VelarBrowserModule } from '../../../dist/browser/contract/surface.js'
import { VelarComputerModule } from '../../../dist/computer/contract/surface.js'
import { VelarOfficeModule } from '../../../dist/office/contract/surface.js'

import { done, modelText, turn } from './support/model-turn.mjs'

const driver = (stream) => ({
  id: 'instructions-test',
  limits: { contextTokens: 100000, inputTokens: 90000, outputTokens: 4096 },
  estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'test' }),
  stream,
})
async function fixture(t, options) {
  const dataDir = await mkdtemp(join(tmpdir(), 'runtime-instructions-'))
  const runtime = await createRuntime({
    dataDir,
    agents: false,
    search: false,
    memory: false,
    context: { maintenance: false },
    ...options,
  })
  t.after(async () => {
    await runtime.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  return { runtime, dataDir, session: await runtime.openSession('main') }
}

const inventory = (request) =>
  JSON.parse(request.materials.find((item) => item.origin === 'runtime-view').text).partitions
    .runtime.inventory

test('INV-57 子任务首帧按自己的授权展示能力，不继承父任务专属入口', async (t) => {
  const parentFrames = []
  const childFrames = []
  const surface = VelarOfficeModule
  const office = createCapabilityModule({
    surface,
    instanceId: surface.specifier,
    implementation: Object.fromEntries(
      surface.methods.map((name) => [name, () => assert.fail('discovery ran office')])
    ),
    context: () => assert.fail('discovery constructed office context'),
  })
  const f = await fixture(t, {
    modules: [office],
    agents: {
      concurrency: 1,
      maxChildren: 1,
      profiles: {
        worker: {
          modules: [],
          node: true,
          model: driver(async function* (request) {
            childFrames.push(request)
            yield* done(request)
          }),
        },
      },
    },
    model: driver(async function* (request) {
      parentFrames.push(request)
      if (parentFrames.length === 1) {
        yield turn(request, {
          execute: {
            source:
              "import {start,wait} from 'velaros:agents';const job=await start({task:'Describe this environment',profile:'worker'});console.log(await wait({id:job.id}));",
          },
        })
        yield { type: 'finish', reason: 'stop' }
      } else yield* done(request)
    }),
  })
  for await (const event of f.session.submit('Delegate a small inspection'))
    assert.notEqual(event.type, 'error', JSON.stringify(event))
  assert.ok(
    inventory(parentFrames[0]).capabilities.some((item) => item.module === 'velaros:office')
  )
  assert.ok(childFrames.length > 0)
  assert.ok(
    !inventory(childFrames[0]).capabilities.some((item) =>
      ['velaros:office', 'velaros:agents'].includes(item.module)
    )
  )
  assert.ok(inventory(childFrames[0]).packages.length > 0)
})

test('INV-57 首帧直接交付真实领域能力用途和已安装 npm，详细合同按需查询', async (t) => {
  const frames = []
  const modules = [VelarOfficeModule, VelarComputerModule, VelarBrowserModule].map((surface) =>
    createCapabilityModule({
      surface,
      instanceId: surface.specifier,
      implementation: Object.fromEntries(
        surface.methods.map((name) => [name, () => assert.fail('discovery executed an operation')])
      ),
      context: () => assert.fail('discovery constructed an operation context'),
    })
  )
  const workspace = await mkdtemp(join(tmpdir(), 'runtime-primer-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const f = await fixture(t, {
    workspace,
    modules,
    model: driver(async function* (request) {
      frames.push(request)
      yield* done(request)
    }),
  })
  for await (const event of f.session.submit('What can this environment do?'))
    assert.notEqual(event.type, 'error', JSON.stringify(event))
  const first = inventory(frames[0])
  for (const module of [
    'velaros:office',
    'velaros:computer',
    'velaros:browser',
    'velaros:project',
  ]) {
    const card = first.capabilities.find((item) => item.module === module)
    assert.equal(card.summary, f.runtime.describe(module).summary.slice(0, 180))
    assert.ok(frames[0].compiledPrompt.includes(module))
    assert.ok(frames[0].compiledPrompt.includes(card.summary))
    assert.ok(!frames[0].instructions.includes(f.runtime.describe(module).declarations))
  }
  assert.ok(
    first.capabilities.some(
      (item) => item.module === 'velaros:system' && item.member === 'environment'
    )
  )
  assert.ok(first.capabilities.every((item) => !item.module.startsWith('velaros:system-')))
  assert.ok(!JSON.stringify(first).includes('velaros:search'))
  for (const pkg of nodeRuntimePackages.defaults())
    assert.deepEqual(
      first.packages.find((item) => item.name === pkg.name),
      { name: pkg.name, runtimeImport: `velaros:npm/${pkg.name}`, fallbackVersion: pkg.version }
    )
  assert.equal(first.totals.capabilities, first.capabilities.length)
  assert.match(frames[0].instructions, /runtime.inventory/)
})

test('INV-57 首帧后备包版本与执行进程实际工作区解析身份分别表达', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'runtime-package-shadow-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const directory = join(workspace, 'node_modules', 'execa')
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ name: 'execa', version: '0.0.1-workspace', main: 'index.cjs' })
  )
  await writeFile(join(directory, 'index.cjs'), 'module.exports = () => "workspace-export";')
  const frames = []
  const f = await fixture(t, {
    workspace,
    model: driver(async function* (request) {
      frames.push(request)
      if (frames.length === 1) {
        yield turn(request, {
          execute: {
            source:
              'import execa from "execa"; import {execa as hostExeca} from "velaros:npm/execa"; import {readFile} from "node:fs/promises"; const catalog=JSON.parse(await readFile(process.env.VELAROS_HOST_DIR+"/index.json","utf8")); const pkg=catalog.packages.find(p=>p.name==="execa"); console.log(JSON.stringify({value:execa(),hostExeca:typeof hostExeca,source:pkg.source,version:pkg.version,runtimeImport:pkg.runtimeImport,runtimeVersion:pkg.runtimeVersion}));',
          },
        })
        yield { type: 'finish', reason: 'stop' }
      } else yield* done(request)
    }),
  })
  for await (const event of f.session.submit('Inspect the workspace package identity'))
    assert.notEqual(event.type, 'error', JSON.stringify(event))
  const hint = inventory(frames[0]).packages.find((item) => item.name === 'execa')
  assert.equal(
    hint.fallbackVersion,
    nodeRuntimePackages.defaults().find((p) => p.name === 'execa').version
  )
  assert.equal(Object.hasOwn(hint, 'version'), false)
  assert.equal(hint.runtimeImport, 'velaros:npm/execa')
  assert.match(frames[0].instructions, /import \{execa\} from "velaros:npm\/execa"/)
  const history = JSON.stringify(frames[1].history)
  for (const value of [
    'workspace-export',
    '0.0.1-workspace',
    'source',
    'runtimeVersion',
    'hostExeca',
  ])
    assert.ok(history.includes(value), value)
})

test('INV-57 环境引子读取所选 Skill 和损坏包的实际状态，元数据租约完整释放', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'runtime-primer-packages-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  for (const name of ['primer-package', 'primer-broken']) {
    await mkdir(join(directory, 'node_modules', name), { recursive: true })
    await writeFile(
      join(directory, 'node_modules', name, 'package.json'),
      name === 'primer-broken' ? '{broken' : JSON.stringify({ name, version: '2.3.4' })
    )
  }
  let acquired = 0
  let released = 0
  const frames = []
  const f = await fixture(t, {
    packageEnvironment: false,
    node: {
      cwd: directory,
      directory: join(directory, 'runs'),
      execute: () => assert.fail('primer launched a process'),
      acquireRuntime: async () => {
        acquired++
        return {
          environment: {
            id: 'selected-skills',
            packages: ['primer-package', 'primer-broken'].map((name) => ({
              name,
              version: 'old-metadata',
              directory,
              skill: 'fixture-skill',
            })),
            skills: [
              {
                name: 'fixture-skill',
                version: '3.0.0',
                description: '解析科学数据',
                directory,
                packages: ['primer-package'],
                capabilities: [],
              },
            ],
          },
          binDirectories: [],
          release: async () => {
            released++
          },
        }
      },
    },
    model: driver(async function* (request) {
      frames.push(request)
      yield* done(request)
    }),
  })
  for await (const event of f.session.submit('Explain available dependencies'))
    assert.notEqual(event.type, 'error', JSON.stringify(event))
  const first = inventory(frames[0])
  assert.equal(
    first.packages.find((item) => item.name === 'primer-package').fallbackVersion,
    '2.3.4'
  )
  assert.ok(first.packages.find((item) => item.name === 'primer-broken').error)
  assert.deepEqual(first.skills, [
    { name: 'fixture-skill', version: '3.0.0', description: '解析科学数据' },
  ])
  assert.ok(acquired > 0)
  assert.equal(acquired, released)
})

test('INV-57 环境清单读取失败仍交付能力和诊断，不阻断模型请求', async (t) => {
  const frames = []
  const f = await fixture(t, {
    packageEnvironment: false,
    node: {
      cwd: process.cwd(),
      directory: join(tmpdir(), 'unused-primer-runs'),
      execute: () => assert.fail('primer launched a process'),
      acquireRuntime: async () => {
        throw new Error('fixture inventory unavailable')
      },
    },
    model: driver(async function* (request) {
      frames.push(request)
      yield* done(request)
    }),
  })
  for await (const event of f.session.submit('Diagnose my environment'))
    assert.notEqual(event.type, 'error', JSON.stringify(event))
  assert.match(inventory(frames[0]).npm.error, /fixture inventory unavailable/)
  assert.ok(inventory(frames[0]).capabilities.length > 0)
})

test('INV-57 大目录遵守展示预算并保留完整数量，常规环境保留用途与版本', () => {
  const full = {
    capabilities: Array.from({ length: 40 }, (_, i) => ({
      module: `example:module-${i}`,
      summary: '用途说明'.repeat(100),
    })),
    packages: Array.from({ length: 128 }, (_, i) => ({
      name: `package-${i}`,
      fallbackVersion: '1.2.3',
    })),
    skills: [{ name: 'test-skill', version: '1', description: 'skill 用途' }],
    totals: { capabilities: 40, packages: 128, skills: 1 },
  }
  const limited = boundedInventory(full, 1500)
  assert.ok(JSON.stringify(limited).length <= 1500)
  assert.deepEqual(limited.totals, full.totals)
  assert.ok(
    limited.capabilities.length > 0 && limited.capabilities.length < full.capabilities.length
  )
  assert.ok(limited.packages.length > 0 && limited.packages.length < full.packages.length)
  assert.equal(full.capabilities.length, 40)
  assert.equal(full.packages.length, 128)
})

test('base instructions stay small while authorized packages are discoverable on demand', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'runtime-domain-guidance-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  for (const project of [false, true]) {
    let instructions
    const f = await fixture(t, {
      workspace,
      project,
      model: driver(async function* (request) {
        instructions = request.instructions
        yield* done(request)
      }),
    })
    for await (const event of f.session.submit('Translate 今天晴天.'))
      assert.notEqual(event.type, 'error')
    assert.match(instructions, /Node.js/)
    assert.match(instructions, /index.json/)
    const prefixChars = instructions.split('完整响应全部校验后才执行')[0].length
    assert(prefixChars < 1800, `instruction prefix has ${prefixChars} characters`)
    assert(instructions.length < 3600, 'full control semantics must remain bounded')
    const result = await f.session.execute({
      source: `import {readFile} from 'node:fs/promises'; const catalog=JSON.parse(await readFile(process.env.VELAROS_HOST_DIR+'/index.json','utf8')); export default catalog.capabilities.some(item=>item.module==='velaros:project');`,
    })
    assert.equal(result.result.value, project)
  }
})

test('Node hints expose only available collaboration and search capabilities without their contracts', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'runtime-capability-hints-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  await writeFile(join(workspace, 'entry.ts'), 'export const value = 1\n')
  for (const agents of [false, true]) {
    for (const search of [false, true]) {
      let instructions
      const f = await fixture(t, {
        workspace,
        project: { code: true },
        agents,
        search,
        model: driver(async function* (request) {
          instructions = request.instructions
          yield* done(request)
        }),
      })
      for await (const event of f.session.submit('Explain the current task.'))
        assert.notEqual(event.type, 'error')
      assert.equal(instructions.includes('velaros:agents'), agents)
      assert.equal(instructions.includes('velaros:search'), search)
      assert(!instructions.includes('velaros:context-materials'))
      assert.doesNotMatch(instructions, /export function|AgentStartInput|SearchRequest/)
      const prefixChars = instructions.split('完整响应全部校验后才执行')[0].length
      assert(prefixChars < 1800, `instruction prefix has ${prefixChars} characters`)
      assert(instructions.length < 3600, 'full control semantics must remain bounded')
    }
  }
})

test('project batch transformations reuse actual read targets and preserve source formatting', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'runtime-bound-batch-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const originals = new Map([
    ['main.py', 'def status():\n\t"""pending 🌈"""\n\treturn "pending"\n'],
    ['main.ts', 'export const status = "pending"\r\n\r\n// 🌈\r\n'],
    ['main.json', '{\n  "status": "pending",\n  "path": "C:\\\\temp"\n}\n'],
    ['main.md', '# pending\n\n\n    pending 🌈\n'],
    ['other.py', "class Status:\n\n    state = 'pending'\n\n"],
    ['other.ts', '// pending\nexport const mark = `pending`;\n'],
  ])
  for (const [name, text] of originals) await writeFile(join(workspace, name), text)
  const paths = [...originals.keys()]
  const frames = []
  const f = await fixture(t, {
    workspace,
    residentModules: [{ module: 'velaros:project', exports: ['read', 'patch'] }],
    model: driver(async function* (request) {
      frames.push(request)
      if (frames.length === 1) {
        yield turn(request, {
          execute: {
            source: `import {read,patch} from 'velaros:project';import {output} from 'velaros';
const files=${JSON.stringify(paths)}.map(path=>({path}));
const current=await read({files});
if(current.issues?.length||current.files.some(file=>!file.target))throw Error('Incomplete source targets');
const change=await patch({edits:current.files.map(file=>({target:file.target,text:file.text.replaceAll('pending','ready')}))});
if(change.status!=='applied')throw Error(JSON.stringify(change));
output({status:change.status,changeRef:change.changeRef,files:change.changedFiles});`,
          },
        })
        yield { type: 'finish', reason: 'stop' }
      } else yield* done(request)
    }),
  })
  for await (const event of f.session.submit('Update the six related status files atomically.'))
    assert.notEqual(event.type, 'error', JSON.stringify(event))
  assert.equal(frames.length, 2)
  assert.match(frames[0].instructions, /index.json/)
  assert.doesNotMatch(frames[0].instructions, /export function patch/)
  for (const [name, original] of originals)
    assert.equal(
      await readFile(join(workspace, name), 'utf8'),
      original.replaceAll('pending', 'ready')
    )
})

test('INV-43 trusted host instructions reach actual requests and traces; reopen uses current product settings', async (t) => {
  const frames = []
  const model = driver(async function* (request) {
    frames.push(request)
    yield* done(request)
  })
  const f = await fixture(t, { model, instructions: 'host-language-first' })
  const events = []
  for await (const event of f.session.submit('user-text-only')) events.push(event)
  assert.match(frames[0].instructions, /host-language-first/)
  assert.match(frames[0].instructions, /Node.js/)
  assert.match(frames[0].compiledPrompt, /当前帧标记/)
  const turn = events.find((event) => event.type === 'turn')
  const trace = await f.session.trace(turn.turnId)
  assert.match(trace.request.body, /host-language-first/)
  await f.runtime.close()
  const reopened = await createRuntime({
    dataDir: f.dataDir,
    model,
    instructions: 'host-language-second',
    agents: false,
    search: false,
    memory: false,
    context: { maintenance: false },
  })
  try {
    const session = await reopened.openSession('main')
    for await (const event of session.submit('next user text')) assert.notEqual(event.type, 'error')
    assert.match(frames.at(-1).instructions, /host-language-second/)
    assert.doesNotMatch(frames.at(-1).instructions, /host-language-first/)
  } finally {
    await reopened.close()
  }
})

test('host instructions are budgeted before the provider is called', async (t) => {
  let calls = 0
  const estimates = []
  const model = {
    ...driver(async function* (request) {
      calls++
      yield* done(request)
    }),
    estimate: async (request) => {
      estimates.push(request.instructions)
      return {
        tokens: request.instructions.includes('large-host-setting') ? 200000 : 1000,
        precision: 'exact',
        basis: 'instruction-sensitive',
      }
    },
  }
  const f = await fixture(t, { model, instructions: 'large-host-setting' })
  const events = []
  for await (const event of f.session.submit('small user input')) events.push(event)
  assert.equal(calls, 0)
  assert(estimates.some((text) => text.includes('large-host-setting')))
  assert.equal(events.at(-1).status, 'context_blocked')
})

test('repair requests retain host instructions without accepting malformed responses', async (t) => {
  const frames = []
  const f = await fixture(t, {
    instructions: 'host-repair-setting',
    model: driver(async function* (request) {
      frames.push(request)
      if (frames.length === 1) {
        yield { type: 'text', text: 'missing frame control' }
        yield { type: 'finish', reason: 'stop' }
      } else yield* done(request)
    }),
  })
  const events = []
  for await (const event of f.session.submit('answer')) events.push(event)
  assert.equal(events.at(-1).status, 'completed')
  assert(events.some((event) => event.type === 'rejected'))
  assert(frames.length >= 2)
  assert(frames.every((frame) => frame.instructions.includes('host-repair-setting')))
})

test('invalid host instruction configuration is rejected before runtime activation', async () => {
  await assert.rejects(createRuntime({ instructions: { text: 'invalid' } }), /instructions/)
})

test('legacy resident hints leave complete contracts in the on-demand directory', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'runtime-resident-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const frames = []
  const model = driver(async function* (request) {
    frames.push(request)
    yield* done(request)
  })
  const f = await fixture(t, {
    model,
    workspace,
    residentModules: [{ module: 'velaros:project' }, { module: 'velaros:not-mounted' }],
  })
  for await (const event of f.session.submit('read the readme'))
    assert.notEqual(event.type, 'error')
  const declarations = f.runtime.describe('velaros:project').declarations
  assert.match(frames[0].instructions, /index.json/)
  assert.ok(!frames[0].instructions.includes(declarations))
  assert.doesNotMatch(frames[0].instructions, /velaros:not-mounted/)
})

test('INV-85 packages execute by name and templates remain discoverable with a stable instruction prefix', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'runtime-resident-template-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  await writeFile(join(workspace, 'sample.txt'), 'before\n')
  const frames = []
  const widgets = []
  const f = await fixture(t, {
    workspace,
    widgets: { show: async (widget) => widgets.push(widget) },
    residentModules: [{ module: 'velaros:project' }, { module: 'velaros:widget' }],
    model: driver(async function* (request) {
      frames.push(request)
      for (const module of ['velaros:project', 'velaros:widget']) {
        const description = f.runtime.describe(module)
        assert(!request.instructions.includes(description.declarations))
        assert(!request.instructions.includes(description.template))
      }
      if (frames.length === 1) {
        yield turn(request, {
          execute: {
            source: `import {read,edit} from 'velaros:project';import {show} from 'velaros:widget';import {output} from 'velaros';
output(await edit({steps:[{action:'replace',path:'sample.txt',oldText:'before',newText:'after'}]}));
output(await read({files:[{path:'sample.txt'}]}));
await show({title:'Result',code:'<svg xmlns="http://www.w3.org/2000/svg"><text>after</text></svg>'});`,
          },
        })
        yield { type: 'finish', reason: 'stop' }
      } else if (frames.length === 2) {
        assert.match(modelText(request), /after/)
        assert.equal(widgets.length, 1)
        yield turn(request, {
          execute: {
            source:
              "import {modules} from 'velaros:system';import {output} from 'velaros';output((await modules.describe({module:'velaros:project',exports:['edit'],template:true})).template,{type:'code'});",
          },
        })
        yield { type: 'finish', reason: 'stop' }
      } else {
        assert.equal(frames.length, 3)
        assert(modelText(request).includes(f.runtime.describe('velaros:project').template))
        yield* done(request)
      }
    }),
  })
  const events = []
  for await (const event of f.session.submit(
    'Change before to after, show it, then read the edit example'
  ))
    events.push(event)
  assert.equal(events.at(-1).status, 'completed')
  assert.equal(await readFile(join(workspace, 'sample.txt'), 'utf8'), 'after\n')
  assert.equal(widgets.length, 1)
  assert.match(widgets[0].code, /after/)
  assert(frames.every((frame) => frame.instructions === frames[0].instructions))
  const trace = await f.runtime.trace('main', { fullContent: true })
  assert(
    trace.turns.every((turn) => turn.requestSummary.system === trace.turns[0].requestSummary.system)
  )
})

test('INV-85 template hints keep instructions small for whole and selected package declarations', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'runtime-resident-template-explicit-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  for (const residentModules of [
    [{ module: 'velaros:project', template: false }],
    [
      { module: 'velaros:project', template: false },
      { module: 'velaros:project', exports: ['edit'], template: true },
      { module: 'velaros:project', template: true },
    ],
    [{ module: 'velaros:project', exports: ['edit'], template: true }],
  ]) {
    let instructions
    const f = await fixture(t, {
      workspace,
      residentModules,
      model: driver(async function* (request) {
        instructions = request.instructions
        yield* done(request)
      }),
    })
    for await (const event of f.session.submit('Ready')) assert.notEqual(event.type, 'error')
    const template = f.runtime.describe('velaros:project').template
    assert.equal(instructions.split(template).length - 1, 0)
  }
})

test('INV-85 resident template flags reject nonboolean configuration before activation', async () => {
  for (const template of [null, 'true', 1, {}, []])
    await assert.rejects(
      createRuntime({ residentModules: [{ module: 'velaros:project', template }] }),
      { code: 'VALIDATION' }
    )
})

test('INV-57 the on-demand catalog contains every authorized package and complete declarations', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'runtime-importable-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const f = await fixture(t, { workspace, project: { code: true, images: true } })
  await f.session.context.append({ kind: 'user', body: 'Inspect authorized packages' })
  const result = await f.session.execute({
    source: `
    import {readFile} from 'node:fs/promises'; import {join} from 'node:path';
    const dir=process.env.VELAROS_HOST_DIR; const entries=JSON.parse(await readFile(join(dir,'index.json'),'utf8'));
    export default await Promise.all(['velaros:project','velaros:code','velaros:images'].map(async name=>{
      const entry=entries.capabilities.find(item=>item.module===name);
      const types=await readFile(join(dir,entry.documentation),'utf8');
      return {name,summary:entry.summary,types:types.includes('export function')};
    }));`,
  })
  assert.equal(result.result.failed, undefined, JSON.stringify(result))
  assert.equal(result.result.value.length, 3)
  for (const item of result.result.value) {
    assert(item.types)
    assert.equal(item.summary, f.runtime.describe(item.name).summary)
  }
})

test('resident modules must be a list of module names', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'runtime-resident-invalid-'))
  try {
    await assert.rejects(
      createRuntime({ dataDir, residentModules: 'velaros:project', agents: false, search: false }),
      { code: 'VALIDATION' }
    )
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('INV-67 selected package hints allow execution on the first response without loading types into instructions', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'runtime-resident-export-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  await writeFile(join(workspace, 'sample.txt'), 'before\n')
  const frames = []
  const f = await fixture(t, {
    workspace,
    residentModules: [
      { module: 'velaros:project', exports: ['read'] },
      { module: 'velaros:project', exports: ['edit'] },
      { module: 'velaros:project', exports: ['edit'] },
      { module: 'velaros:not-mounted', exports: ['anything'] },
    ],
    model: driver(async function* (request) {
      frames.push(request)
      if (frames.length === 1) {
        yield turn(request, {
          execute: {
            source: `import {read,edit} from 'velaros:project';import {output} from 'velaros';
const change=await edit({steps:[{action:'replace',path:'sample.txt',oldText:'before',newText:'after'}]});
output(change);output(await read({files:[{path:'sample.txt'}]}));`,
          },
        })
        yield { type: 'finish', reason: 'stop' }
      } else yield* done(request)
    }),
  })
  const events = []
  for await (const event of f.session.submit('Change before to after and read the result'))
    events.push(event)
  assert.equal(events.at(-1).status, 'completed')
  assert.equal(frames.length, 2)
  assert.equal(await readFile(join(workspace, 'sample.txt'), 'utf8'), 'after\n')
  assert.match(modelText(frames[1]), /after/)
  assert.match(frames[0].instructions, /index.json/)
  assert.doesNotMatch(frames[0].instructions, /export function (read|edit)/)
  assert.equal(frames[1].instructions, frames[0].instructions)
})

test('INV-67 duplicate legacy package hints do not duplicate instructions or restrict real imports', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'runtime-resident-whole-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const frames = []
  const f = await fixture(t, {
    workspace,
    residentModules: [
      { module: 'velaros:project', exports: ['edit'] },
      { module: 'velaros:project' },
      { module: 'velaros:project' },
    ],
    model: driver(async function* (request) {
      frames.push(request)
      yield* done(request)
    }),
  })
  for await (const event of f.session.submit('Ready')) assert.notEqual(event.type, 'error')
  assert.equal(frames[0].instructions.split('常驻模块 velaros:project 的声明').length - 1, 0)
  assert.doesNotMatch(frames[0].instructions, /常驻导出 velaros:project/)
  const invalid = await createRuntime({
    dataDir: join(f.dataDir, 'invalid'),
    workspace,
    agents: false,
    search: false,
    memory: false,
    residentModules: [
      { module: 'velaros:project' },
      { module: 'velaros:project', exports: ['nonexistent'] },
    ],
    model: driver(async function* (request) {
      yield* done(request)
    }),
  })
  try {
    const session = await invalid.openSession('invalid')
    await session.context.append({ kind: 'user', body: 'Check invalid package export' })
    const result = await session.execute({
      source: "import {nonexistent} from 'velaros:project'; nonexistent();",
    })
    assert(result.result.failed)
    assert.match(result.result.process.stderr, /nonexistent/)
  } finally {
    await invalid.close()
  }
})

test('INV-67 invalid selected resident configuration is rejected before activation', async () => {
  for (const value of [
    null,
    3,
    {},
    'velaros:project',
    { module: '', exports: ['edit'] },
    { module: 'velaros:project', exports: [''] },
    { module: 'velaros:project', exports: 'edit' },
    { module: 'velaros:project', exports: [] },
    { module: 'velaros:project', exports: Array(65).fill('edit') },
  ]) {
    await assert.rejects(createRuntime({ residentModules: [value] }), { code: 'VALIDATION' })
  }
})

test('INV-67 on-demand package declarations leave the default request capacity available', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'runtime-resident-budget-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  let calls = 0
  const estimates = []
  const f = await fixture(t, {
    workspace,
    residentModules: [{ module: 'velaros:project', exports: ['edit'] }],
    model: {
      ...driver(async function* (request) {
        calls++
        yield* done(request)
      }),
      estimate: async (request) => {
        estimates.push(request.instructions)
        return {
          tokens: request.instructions.includes('export function edit(') ? 200000 : 1000,
          precision: 'exact',
          basis: 'resident-sensitive',
        }
      },
    },
  })
  const events = []
  for await (const event of f.session.submit('small user input')) events.push(event)
  assert.equal(calls, 1)
  assert(estimates.every((text) => !text.includes('export function edit(')))
  assert.equal(events.at(-1).status, 'completed')
})

test('every frame carries the local clock and host environment entries in runtime.environment', async (t) => {
  const frames = []
  const f = await fixture(t, {
    model: driver(async function* (request) {
      frames.push(request)
      yield* done(request)
    }),
    environment: () => ({ os: 'macOS 26.3.1 (arm64)', time: 'host-cannot-override' }),
  })
  for await (const event of f.session.submit('what time is it'))
    assert.notEqual(event.type, 'error')
  const environment = JSON.parse(frames[0].materials[0].text).partitions.runtime.environment
  assert.equal(environment.os, 'macOS 26.3.1 (arm64)')
  assert.match(environment.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
  assert(Math.abs(Date.parse(environment.time) - Date.now()) < 60_000)
  assert.match(environment.localTime, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [A-Z][a-z]+day$/)
  assert.equal(environment.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone)
  assert.match(frames[0].instructions, /Node.js/)
})

test('a failing host environment drops only its own entries and the run goes on', async (t) => {
  const frames = []
  const f = await fixture(t, {
    model: driver(async function* (request) {
      frames.push(request)
      yield* done(request)
    }),
    environment: () => {
      throw new Error('probe failed')
    },
  })
  const events = []
  for await (const event of f.session.submit('answer')) events.push(event)
  assert.equal(events.at(-1).status, 'completed')
  const environment = JSON.parse(frames[0].materials[0].text).partitions.runtime.environment
  assert.deepEqual(Object.keys(environment).sort(), ['localTime', 'time', 'timezone'])
})

test('environment must be a function returning host entries', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'runtime-environment-invalid-'))
  try {
    await assert.rejects(
      createRuntime({ dataDir, environment: { os: 'macOS' }, agents: false, search: false }),
      { code: 'VALIDATION' }
    )
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('the frame clock writes the zone offset and weekday of the host time zone', () => {
  const zone = process.env.TZ
  const instant = new Date('2026-09-24T18:11:57Z')
  try {
    for (const [tz, time, localTime] of [
      ['Asia/Shanghai', '2026-09-25T02:11:57+08:00', '2026-09-25 02:11:57 Friday'],
      ['America/New_York', '2026-09-24T14:11:57-04:00', '2026-09-24 14:11:57 Thursday'],
      ['Asia/Kolkata', '2026-09-24T23:41:57+05:30', '2026-09-24 23:41:57 Thursday'],
    ]) {
      process.env.TZ = tz
      // ICU 可能给出同一时区的规范别名（Asia/Kolkata → Asia/Calcutta），时区名以它为准
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
      assert.deepEqual(frameEnvironment(undefined, instant), { time, localTime, timezone })
    }
  } finally {
    if (typeof zone === 'string') process.env.TZ = zone
    else delete process.env.TZ
  }
})

test('large capability indexes keep complete export names and expose omitted directory entries', () => {
  const modules = [
    'velaros:modules',
    'velaros:system-memory-local',
    ...Array.from({ length: 80 }, (_, id) => `velaros:domain-${id}`),
  ]
  const instructions = runtimeInstructions({
    modules,
    maintain: false,
    observe: false,
    summary: (module) => `${module} 用途说明。`,
    index: () => ({
      exports: ['read', 'write', 'completeExportName'],
      contentRevision: 'a'.repeat(64),
    }),
  })
  const note = instructions
    .split('\n')
    .find((line) => line.startsWith('本会话还能直接 import 这些模块'))
  const entries = [...note.matchAll(/velaros:domain-\d+（[^）]+）/gu)]
  assert(entries.length > 0 && entries.length < 80)
  assert(note.length < 4300, '索引配额包含完整条目；目录说明只有固定额外成本')
  for (const entry of entries) {
    assert(entry[0].includes('exports: read, write, completeExportName'))
    assert(entry[0].includes(`contentRevision: ${'a'.repeat(64)}`))
  }
  assert(note.includes(`另有 ${80 - entries.length} 个模块`))
  assert(note.includes('modules.list() 分页读取完整目录'))
})
