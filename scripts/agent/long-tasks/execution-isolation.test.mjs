import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import {
  acquireCampaignExecution,
  executionIsolation,
  signalProfile,
} from './execution-isolation.mjs'
import { registerTaskResources, verifyResourceArchive } from './resource-lifecycle.mjs'

const execute = promisify(execFile)
const hash = (value) => createHash('sha256').update(value).digest('hex')
const mac = process.platform === 'darwin'
const isolationFile = join(import.meta.dirname, 'execution-isolation.mjs')
const launchFile = join(import.meta.dirname, 'launch.mjs')

async function temporary(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'vlr-isolation-test-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

function close(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
}

async function sentinel(t, sandbox = false) {
  const code = "console.log('ready');setInterval(()=>{},1000)"
  const child = spawn(
    sandbox ? '/usr/bin/sandbox-exec' : process.execPath,
    sandbox ? ['-p', signalProfile, process.execPath, '-e', code] : ['-e', code],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  const exited = close(child)
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
  })
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve)
    child.once('error', reject)
    child.once('exit', () => reject(new Error('Sentinel exited before readiness')))
  })
  return child
}

async function fixture(t, body) {
  const campaign = await temporary(t)
  const directory = join(campaign, 'attempt')
  const taskRoot = join(campaign, 'vlr-task-root')
  await mkdir(directory)
  await mkdir(taskRoot)
  const resources = await registerTaskResources(taskRoot, directory)
  const worker = join(directory, 'worker.mjs')
  await writeFile(
    worker,
    `
    import {readFile,writeFile} from 'node:fs/promises';
    import {join} from 'node:path';
    import {spawn} from 'node:child_process';
    import {verifyIsolatedWorker} from ${JSON.stringify(pathToFileURL(isolationFile).href)};
    const directory=process.argv[2];
    const manifest=JSON.parse(await readFile(join(directory,'freeze.json')));
    const proof=await verifyIsolatedWorker(directory,manifest);
    ${body}
  `
  )
  const manifest = {
    controller: launchFile,
    worker,
    campaignDirectory: campaign,
    executionIsolation: executionIsolation(),
    resources,
    taskRoot,
    commandEnvironment: {
      node: process.execPath,
      nodeVersion: process.version,
      path: process.env.PATH,
    },
    files: {},
  }
  for (const path of [launchFile, worker, isolationFile, process.execPath])
    manifest.files[path] = hash(await readFile(path))
  await writeFile(join(directory, 'freeze.json'), JSON.stringify(manifest))
  return { campaign, directory, taskRoot, manifest, worker }
}

test(
  'kernel rejects signals to foreign PIDs and groups, including an identical separate sandbox',
  { skip: !mac, timeout: 20000 },
  async (t) => {
    const foreign = await sentinel(t)
    const otherSandbox = await sentinel(t, true)
    const code = `
      import assert from 'node:assert/strict';
      import {spawn} from 'node:child_process';
      const denied=[];
      for(const pid of ${JSON.stringify([foreign.pid, -foreign.pid, otherSandbox.pid, -otherSandbox.pid])}) {
        for(const signal of ['SIGINT','SIGTERM','SIGKILL']) {
          assert.throws(()=>process.kill(pid,signal),{code:'EPERM'});
          denied.push({pid,signal,result:'EPERM'});
        }
      }
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
      const stopped=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
      child.kill('SIGTERM');
      assert.deepEqual(await stopped,{code:null,signal:'SIGTERM'});
      const group=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
      const groupStopped=new Promise(resolve=>group.once('exit',(code,signal)=>resolve({code,signal})));
      process.kill(-group.pid,'SIGKILL');
      assert.deepEqual(await groupStopped,{code:null,signal:'SIGKILL'});
      console.log(JSON.stringify({denied,ownChild:true,ownProcessGroup:true}));
    `
    const result = await execute(
      '/usr/bin/sandbox-exec',
      ['-p', signalProfile, process.execPath, '--input-type=module', '-e', code],
      { timeout: 10000 }
    )
    assert.equal(JSON.parse(result.stdout).denied.length, 12)
    assert.equal(foreign.exitCode, null)
    assert.equal(foreign.signalCode, null)
    assert.equal(otherSandbox.exitCode, null)
    assert.equal(otherSandbox.signalCode, null)
  }
)

test('campaign lock excludes concurrent attempts and releases only its own identity', async (t) => {
  const campaign = await temporary(t)
  const one = join(campaign, 'one'),
    two = join(campaign, 'two')
  await mkdir(one)
  await mkdir(two)
  const release = await acquireCampaignExecution(campaign, one)
  await assert.rejects(acquireCampaignExecution(campaign, two), /already has an execution lock/u)
  await release()
  const releaseTwo = await acquireCampaignExecution(campaign, two)
  const lock = join(campaign, '.paid-execution.lock')
  const original = JSON.parse(await readFile(lock))
  await writeFile(lock, JSON.stringify({ ...original, nonce: 'replacement-owner' }))
  await assert.rejects(releaseTwo)
  assert.equal(JSON.parse(await readFile(lock)).nonce, 'replacement-owner')
})

test(
  'worker rejects direct execution and forged receipt without a kernel boundary',
  { skip: !mac, timeout: 15000 },
  async (t) => {
    const f = await fixture(
      t,
      "await writeFile(join(directory,'paid-call-marker'),'must not run');"
    )
    await assert.rejects(
      execute(process.execPath, [f.worker, f.directory]),
      /registered evaluation launcher/u
    )
    const launchId = randomUUID()
    await mkdir(join(f.directory, 'isolation'))
    await writeFile(
      join(f.directory, 'isolation', `${launchId}.launch.json`),
      JSON.stringify({
        launchId,
        parentPid: process.pid,
        worker: f.worker,
        freezeSha256: hash(await readFile(join(f.directory, 'freeze.json'))),
        profileSha256: f.manifest.executionIsolation.profileSha256,
      })
    )
    await assert.rejects(
      execute(process.execPath, [f.worker, f.directory], {
        env: { ...process.env, VELAROS_EVAL_LAUNCH_ID: launchId },
      }),
      /Kernel did not enforce/u
    )
    await assert.rejects(access(join(f.directory, 'paid-call-marker')), { code: 'ENOENT' })
  }
)

test(
  'launcher cleans detached owned children before verified archive and releases campaign lock',
  { skip: !mac, timeout: 30000 },
  async (t) => {
    const f = await fixture(
      t,
      `
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{
        detached:true,stdio:'ignore',cwd:manifest.taskRoot});
      child.unref();
      await writeFile(join(directory,'child.json'),JSON.stringify({pid:child.pid}));
      await writeFile(join(manifest.taskRoot,'payload.txt'),'retained payload');
      await writeFile(join(directory,'isolation',proof.launchId+'.completed.json'),
        JSON.stringify({launchId:proof.launchId,finished:true}));
    `
    )
    await execute(process.execPath, [launchFile, f.directory], { timeout: 25000 })
    const { pid } = JSON.parse(await readFile(join(f.directory, 'child.json')))
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
    await assert.rejects(access(f.taskRoot), { code: 'ENOENT' })
    await assert.rejects(access(join(f.campaign, '.paid-execution.lock')), { code: 'ENOENT' })
    const archived = await verifyResourceArchive(join(f.directory, 'execution-resources.jsonl.gz'))
    assert.equal(archived.entries, 2)
    const entries = await readdir(join(f.directory, 'isolation'))
    const exit = JSON.parse(
      await readFile(
        join(
          f.directory,
          'isolation',
          entries.find((n) => n.endsWith('.exit.json'))
        )
      )
    )
    assert.equal(exit.cleanup.scopeEmpty, true)
    assert.equal(exit.failure, null)
    const worker = JSON.parse(
      await readFile(
        join(
          f.directory,
          'isolation',
          entries.find((n) => n.endsWith('.worker.json'))
        )
      )
    )
    assert.equal(worker.foreignSignal.result, 'EPERM')
  }
)

test(
  'launcher cancellation retains evidence, stops its worker and detached task child',
  { skip: !mac, timeout: 30000 },
  async (t) => {
    const f = await fixture(
      t,
      `
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{
        detached:true,stdio:'ignore',cwd:manifest.taskRoot});
      child.unref();
      process.on('SIGTERM',()=>process.exit(0));
      await writeFile(join(directory,'child.json'),JSON.stringify({pid:child.pid}));
      setInterval(()=>{},1000);
    `
    )
    const child = spawn(process.execPath, [launchFile, f.directory], { stdio: 'ignore' })
    const done = close(child)
    t.after(async () => {
      if (child.exitCode === null) child.kill('SIGKILL')
      await done
    })
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        await access(join(f.directory, 'child.json')).then(
          () => true,
          () => false
        )
      )
        break
      await delay(50)
    }
    const target = JSON.parse(await readFile(join(f.directory, 'child.json')))
    child.kill('SIGTERM')
    assert.equal((await done).code, 1)
    assert.throws(() => process.kill(target.pid, 0), { code: 'ESRCH' })
    await access(f.taskRoot)
    await assert.rejects(access(join(f.directory, 'execution-resources.jsonl.gz')), {
      code: 'ENOENT',
    })
    await assert.rejects(access(join(f.campaign, '.paid-execution.lock')), { code: 'ENOENT' })
  }
)

test(
  'changed frozen worker is rejected before any worker action',
  { skip: !mac, timeout: 10000 },
  async (t) => {
    const f = await fixture(t, "await writeFile(join(directory,'paid-call-marker'),'bad');")
    await writeFile(f.worker, "throw new Error('tampered worker')")
    await assert.rejects(
      execute(process.execPath, [launchFile, f.directory]),
      /Frozen input changed/u
    )
    await assert.rejects(access(join(f.directory, 'paid-call-marker')), { code: 'ENOENT' })
    await assert.rejects(access(join(f.campaign, '.paid-execution.lock')), { code: 'ENOENT' })
  }
)

test(
  'successful exit without worker completion proof cannot archive the task',
  { skip: !mac, timeout: 15000 },
  async (t) => {
    const f = await fixture(t, "await writeFile(join(manifest.taskRoot,'evidence'),'retained');")
    await assert.rejects(execute(process.execPath, [launchFile, f.directory]), /completed.json/u)
    await access(join(f.taskRoot, 'evidence'))
    await assert.rejects(access(join(f.directory, 'execution-resources.jsonl.gz')), {
      code: 'ENOENT',
    })
  }
)
