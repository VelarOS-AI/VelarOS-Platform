import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { expect, test } from 'bun:test'

import { writeFileOnceSync } from '../src/utils/FilePersistence'
import { createFileSecretBox } from '../src/utils/FileSecretBox'

test('one-time publication never overwrites a target or leaves a partial file on write failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'velaros-file-once-'))
  try {
    const path = join(root, 'key')
    expect(() => writeFileOnceSync(path, {} as Uint8Array)).toThrow()
    expect(readdirSync(root)).toEqual([])
    expect(writeFileOnceSync(path, 'first')).toBe(true)
    expect(writeFileOnceSync(path, 'second')).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('first')
    expect(readdirSync(root)).toEqual(['key'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('secret boxes authenticate prefix and content, reopen persisted keys and reject corrupt keys', () => {
  const root = mkdtempSync(join(tmpdir(), 'velaros-secret-box-'))
  try {
    const keyPath = join(root, 'key')
    const options = { keyPath: () => keyPath, prefix: Buffer.from('TEST-V1\0') }
    const first = createFileSecretBox(options)
    expect(readdirSync(root)).toEqual([])
    const encrypted = first.encrypt('测试 🔒')
    expect(createFileSecretBox(options).decrypt(encrypted)).toBe('测试 🔒')
    expect(first.decrypt(first.encrypt(''))).toBe('')
    expect(first.encrypt('same')).not.toEqual(first.encrypt('same'))
    encrypted[encrypted.length - 1] ^= 1
    expect(() => first.decrypt(encrypted)).toThrow()
    expect(() => first.decrypt(Buffer.from('invalid'))).toThrow()
    expect(() =>
      createFileSecretBox({ ...options, prefix: Buffer.from('OTHER\0') }).decrypt(
        first.encrypt('value')
      )
    ).toThrow()
    writeFileSync(keyPath, 'broken')
    expect(() => createFileSecretBox(options).prepare()).toThrow('Invalid local secret key')
    expect(readFileSync(keyPath, 'utf8')).toBe('broken')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('concurrent processes encrypt using the same completely published key', async () => {
  const root = mkdtempSync(join(tmpdir(), 'velaros-secret-race-'))
  const children: Array<ReturnType<typeof Bun.spawn>> = []
  try {
    const keyPath = join(root, 'key')
    const source = resolve(import.meta.dir, '../src/utils/FileSecretBox.ts')
    const ciphertexts = await Promise.all(
      Array.from({ length: 8 }, async (_, index) => {
        const code = `import { createFileSecretBox } from ${JSON.stringify(source)};
        const box = createFileSecretBox({keyPath: () => ${JSON.stringify(keyPath)}, prefix: Buffer.from('TEST')});
        process.stdout.write(box.encrypt(${JSON.stringify(String(index))}).toString('base64'));`
        const child = Bun.spawn([process.execPath, '-e', code], { stdout: 'pipe', stderr: 'pipe' })
        children.push(child)
        const [output, error, status] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        expect(error).toBe('')
        expect(status).toBe(0)
        return Buffer.from(output, 'base64')
      })
    )
    const box = createFileSecretBox({ keyPath: () => keyPath, prefix: Buffer.from('TEST') })
    expect(ciphertexts.map((value) => box.decrypt(value))).toEqual(
      Array.from({ length: 8 }, (_, index) => String(index))
    )
    expect(readdirSync(root)).toEqual(['key'])
    expect(readFileSync(keyPath).length).toBe(32)
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill()
    await Promise.all(children.map((child) => child.exited))
    rmSync(root, { recursive: true, force: true })
  }
})

test.skipIf(process.platform === 'win32')('POSIX secret files are private to their owner', () => {
  const root = mkdtempSync(join(tmpdir(), 'secret-mode-'))
  try {
    const path = join(root, 'key')
    expect(writeFileOnceSync(path, 'secret')).toBe(true)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
