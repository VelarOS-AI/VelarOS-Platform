import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { runCodex } from './codex.mjs'
import { createOwnedWorkspaceProcessGuard } from './owned-processes.mjs'

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

for (const mode of ['completion', 'cancellation'])
  test(
    `Codex ${mode} reaps detached owned services while preserving an unrelated service`,
    {
      skip: process.platform !== 'darwin',
    },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'owned-codex-'))
      let processGuard
      let unrelated
      t.after(async () => {
        await processGuard?.stop()
        unrelated?.kill('SIGKILL')
        await rm(root, { recursive: true, force: true })
      })
      const workspace = join(root, 'workspace')
      const directory = join(root, 'output')
      const serviceDirectory = join(workspace, 'nested')
      await Promise.all([mkdir(serviceDirectory, { recursive: true }), mkdir(directory)])
      unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        cwd: directory,
        stdio: 'ignore',
      })
      await once(unrelated, 'spawn')
      processGuard = createOwnedWorkspaceProcessGuard({
        workspace,
        directory,
        resourceId: 'owned-fixture',
      })
      const executable = join(root, 'fake-codex')
      const pidFile = join(directory, 'service.pid')
      const readyFile = join(directory, 'ready')
      const code = `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(readyFile)},'ready');setInterval(()=>{},1000);`
      await writeFile(
        executable,
        `#!${process.execPath}
const fs=require('node:fs');const {spawn}=require('node:child_process');
process.stdin.resume();process.stdin.on('end',()=>{
 const child=spawn(process.execPath,['-e',${JSON.stringify(code)}],{cwd:${JSON.stringify(serviceDirectory)},detached:true,stdio:'ignore'});child.unref();
 fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));
 const wait=setInterval(()=>{if(fs.existsSync(${JSON.stringify(readyFile)})){clearInterval(wait);${mode === 'completion' ? "console.log(JSON.stringify({type:'turn.completed'}));process.exit(0)" : 'setInterval(()=>{},1000)'}}},10);
});
`,
        { mode: 0o700 }
      )
      const cancellation = new AbortController()
      const running = runCodex({
        executable,
        workspace,
        directory,
        baseURL: 'http://127.0.0.1:1/v1',
        apiKey: 'fixture',
        model: 'fixture',
        prompt: 'test',
        timeoutMs: 5000,
        processGuard,
        signal: cancellation.signal,
      })
      if (mode === 'cancellation') {
        let ready = false
        for (let attempt = 0; attempt < 100; attempt++) {
          ready = await readFile(readyFile, 'utf8').then(
            () => true,
            () => false
          )
          if (ready) break
          await delay(20)
        }
        assert(ready, 'Fixture service must be active before cancellation')
        cancellation.abort(new Error('fixture cancellation'))
      }
      const result = await running
      const pid = Number(await readFile(pidFile, 'utf8'))
      assert.equal(alive(pid), false, 'Detached owned service must be gone before returning')
      assert.equal(alive(unrelated.pid), true)
      assert.equal(result.terminalComplete, mode === 'completion')
      assert.equal(result.cancelled, mode === 'cancellation')
      assert.equal(result.ownedProcessCleanup.scopeEmpty, true)
      assert.equal(result.ownedProcessCleanup.outsideScopeDetachedDescendants, 'unknown')
      assert(
        result.ownedProcessCleanup.actions.some(
          (action) => action.pid === pid && action.signal === 'SIGKILL'
        )
      )
      assert.equal((await processGuard.stop()).scopeEmpty, true)
    }
  )

test(
  'An already occupied workspace is refused without signaling its existing process',
  {
    skip: process.platform !== 'darwin',
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'occupied-workspace-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      cwd: root,
      stdio: 'ignore',
    })
    await once(child, 'spawn')
    t.after(() => child.kill('SIGKILL'))
    assert.throws(
      () =>
        createOwnedWorkspaceProcessGuard({
          workspace: root,
          directory: root,
          resourceId: 'occupied-fixture',
        }),
      /already has live processes/u
    )
    assert.equal(alive(child.pid), true)
  }
)
