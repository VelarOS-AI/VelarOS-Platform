// 独占评测工作区的补充进程回收；调用方先验证资源所有权，记录的范围不扩展到其他目录。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { lstatSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

function command(executable, args) {
  try {
    return execFileSync(executable, args, {
      encoding: 'utf8',
      timeout: 4000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    if (error.status === 1 && executable.endsWith('lsof')) return error.stdout ?? ''
    throw error
  }
}

function identity(pid) {
  let row
  try {
    row = command('/bin/ps', ['-p', String(pid), '-o', 'pid=,lstart=,uid=,stat=']).trim()
  } catch (error) {
    if (error.status === 1) return null
    throw error
  }
  const parts = row.split(/\s+/u)
  if (parts.length !== 8 || Number(parts[0]) !== pid || parts[7].startsWith('Z')) return null
  return { pid, startedAt: parts.slice(1, 6).join(' '), uid: Number(parts[6]) }
}

function workspaceProcesses(workspace, pid) {
  const args = ['-nP', '-a', '-d', 'cwd', '-F', 'pn']
  if (pid) args.push('-p', String(pid))
  else args.push('-u', String(process.getuid()))
  const output = command('/usr/sbin/lsof', args)
  const matches = []
  let current
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) current = Number(line.slice(1))
    else if (line.startsWith('n')) {
      const cwd = line.slice(1)
      if (cwd !== workspace && !cwd.startsWith(workspace + sep)) continue
      assert(current !== process.pid, 'Controller must not run inside the owned workspace')
      const owner = identity(current)
      if (owner?.uid === process.getuid()) matches.push({ ...owner, cwd })
    }
  }
  return matches
}

export function createOwnedWorkspaceProcessGuard({ workspace, directory, resourceId }) {
  assert.equal(process.platform, 'darwin', 'Owned cwd process inspection requires macOS')
  assert.equal(typeof resourceId, 'string')
  assert(resourceId.length > 0)
  workspace = realpathSync(workspace)
  directory = realpathSync(directory)
  const original = lstatSync(workspace)
  const inspect = (pid) => {
    const current = lstatSync(workspace)
    assert(current.isDirectory() && !current.isSymbolicLink(), 'Owned workspace was replaced')
    assert.equal(current.dev, original.dev, 'Owned workspace device changed')
    assert.equal(current.ino, original.ino, 'Owned workspace identity changed')
    assert.equal(realpathSync(workspace), workspace, 'Owned workspace path changed')
    return workspaceProcesses(workspace, pid)
  }
  // 任何原有占用都拒绝启动，不能靠目录相同就把现有进程归给新任务。
  assert.equal(inspect().length, 0, 'Exclusive workspace already has live processes')
  const receipt = {
    schema: 1,
    resourceId,
    workspace,
    startedAt: new Date().toISOString(),
    scope: 'registered-exclusive-workspace-cwd',
    outsideScopeDetachedDescendants: 'unknown',
    actions: [],
    scopeEmpty: false,
  }
  const path = join(directory, 'owned-process-cleanup.json')
  const persist = () => {
    writeFileSync(path + '.writing', JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
    renameSync(path + '.writing', path)
  }
  persist()
  let stopping
  return {
    stop() {
      stopping ??= (async () => {
        try {
          for (const signal of ['SIGTERM', 'SIGKILL']) {
            for (const owner of inspect()) {
              // 发信号前重读身份与 cwd，拒绝 PID 复用或进程已经移出授权范围。
              const current = inspect(owner.pid).find(
                (entry) => entry.pid === owner.pid && entry.startedAt === owner.startedAt
              )
              if (!current) continue
              const action = { ...current, signal, requestedAt: new Date().toISOString() }
              receipt.actions.push(action)
              persist()
              try {
                process.kill(current.pid, signal)
              } catch (error) {
                if (error.code !== 'ESRCH') throw error
                action.alreadyExited = true
              }
            }
            for (let attempt = 0; attempt < 5; attempt++) {
              await delay(100)
              if (inspect().length === 0) {
                receipt.scopeEmpty = true
                receipt.finishedAt = new Date().toISOString()
                persist()
                return receipt
              }
            }
          }
          throw new Error('Owned workspace still has live processes after bounded cleanup')
        } catch (error) {
          receipt.inspectionError = error.code ?? error.message
          persist()
          throw error
        }
      })()
      return stopping
    },
  }
}
