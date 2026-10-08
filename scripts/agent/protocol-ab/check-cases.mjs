#!/usr/bin/env node
// 在付费调用之前用独立正确产物和破坏产物验证每个验收器。
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { cases, references, suiteHash } from './validation-cases.mjs'
const exec = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'protocol-oracles-'))
try {
  for (const item of cases) {
    const workspace = join(root, item.id)
    await mkdir(workspace)
    for (const [path, text] of Object.entries({ ...item.files, ...references[item.id] })) {
      await mkdir(resolve(workspace, path, '..'), { recursive: true })
      await writeFile(join(workspace, path), text)
    }
    const grade = join(root, `grade-${item.id}.mjs`)
    await writeFile(grade, item.grade)
    await exec(process.execPath, [grade, workspace])
    for (const script of item.rerun ?? []) {
      await exec(process.execPath, [script], { cwd: workspace })
      await exec(process.execPath, [grade, workspace])
    }
    const broken = Object.keys(references[item.id])[0]
    await writeFile(
      join(workspace, broken),
      broken.endsWith('.mjs') ? 'export function mergeRanges(){return []}' : 'BROKEN'
    )
    await assert.rejects(exec(process.execPath, [grade, workspace]))
    console.log(`PASS oracle positive/negative: ${item.id}`)
  }
  console.log(JSON.stringify({ suiteHash, cases: cases.length }))
} finally {
  await rm(root, { recursive: true, force: true })
}
