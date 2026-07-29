/**
 * @test-meta
 * title: 工作区类型脚本插件
 * summary: 发布契约：验证符号解析、替换与导入编辑行为。
 * area: packages
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { test } from 'bun:test';

import { createWorkspace, typescriptPlugin } from '../dist/index.js';

test('typescript plugin resolves methods and replaces symbols with AST ranges', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'velaros-ts-'));
  try {
    await writeFile(path.join(root, 'auth.ts'), `import { verify } from "./jwt";\n\nexport class AuthService {\n  loginUser(name: string) {\n    return name;\n  }\n\n  refreshToken(token: string) {\n    return verify(token);\n  }\n}\n`);
    const ws = await createWorkspace({ root, plugins: [typescriptPlugin()] });
    const symbols = await ws.listSymbols('auth.ts');
    assert.ok(symbols.some((s) => s.name === 'refreshToken' && s.container === 'AuthService'));
    const resolved = await ws.resolveTarget({ path: 'auth.ts', target: { symbol: { kind: 'method', container: 'AuthService', name: 'refreshToken' } }, expectedMatches: 1 });
    assert.equal(resolved.status, 'resolved');
    const tx = await ws.prepareEdit({ operations: [{ targetId: resolved.target.targetId, operation: { type: 'replace_symbol', replacement: `refreshToken(token: string) {\n    if (!token) return "";\n    return verify(token);\n  }` } }] });
    assert.ok(tx.diff.includes('if (!token)'));
    await ws.applyEdit({ transactionId: tx.transactionId });
    const validation = await ws.validate({ paths: ['auth.ts'], checks: ['typescript.syntax'] });
    assert.equal(validation.ok, true);
    const next = await readFile(path.join(root, 'auth.ts'), 'utf8');
    assert.ok(next.includes('if (!token)'));
    assert.ok(next.includes('loginUser'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('typescript plugin can add named imports', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'velaros-ts-import-'));
  try {
    await writeFile(path.join(root, 'index.ts'), `import { a } from "lib";\n\nexport const value = a;\n`);
    const ws = await createWorkspace({ root, plugins: [typescriptPlugin()] });
    const tx = await ws.prepareEdit({ operations: [{ operation: { type: 'add_import', path: 'index.ts', module: 'lib', named: ['b'] } }] });
    await ws.applyEdit({ transactionId: tx.transactionId });
    const next = await readFile(path.join(root, 'index.ts'), 'utf8');
    assert.ok(next.includes('import { a, b } from "lib";'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('replace_symbol mode=body keeps signature with default object param and object return type (AST body range)', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'velaros-ts-body-'));
  try {
    // 签名同时含默认参数对象 `= {}` 和返回类型对象字面量 `: { ok: boolean }`：
    // 朴素 indexOf("{") 会取到这两个花括号之一并改坏签名；AST body 区间应只命中函数体。
    await writeFile(
      path.join(root, 'cfg.ts'),
      `export function build(options = {}): { ok: boolean } {\n  return { ok: true };\n}\n`
    );
    const ws = await createWorkspace({ root, plugins: [typescriptPlugin()] });
    const resolved = await ws.resolveTarget({
      path: 'cfg.ts',
      target: { symbol: { kind: 'function', name: 'build' } },
      expectedMatches: 1,
    });
    assert.equal(resolved.status, 'resolved');
    const tx = await ws.prepareEdit({
      operations: [
        {
          targetId: resolved.target.targetId,
          operation: { type: 'replace_symbol', mode: 'body', replacement: `\n  return { ok: false };\n` },
        },
      ],
    });
    await ws.applyEdit({ transactionId: tx.transactionId });
    const next = await readFile(path.join(root, 'cfg.ts'), 'utf8');
    assert.ok(next.includes('export function build(options = {}): { ok: boolean } {'), next);
    assert.ok(next.includes('return { ok: false };'), next);
    assert.ok(!next.includes('return { ok: true };'), next);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('add_import honors a full importStatement with no module field', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'velaros-ts-importstmt-'));
  try {
    await writeFile(path.join(root, 'index.ts'), `export const value = 1;\n`);
    const ws = await createWorkspace({ root, plugins: [typescriptPlugin()] });
    const tx = await ws.prepareEdit({
      operations: [{ operation: { type: 'add_import', path: 'index.ts', importStatement: `import { foo } from "./foo";` } }],
    });
    await ws.applyEdit({ transactionId: tx.transactionId });
    const next = await readFile(path.join(root, 'index.ts'), 'utf8');
    assert.ok(next.includes('import { foo } from "./foo";'), next);
    assert.ok(!next.includes('undefined'), next);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('replace_symbol on one binding of a multi-declaration const leaves siblings intact', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'velaros-ts-multidecl-'));
  try {
    // `const a = 1, b = 2` 共享一条 VariableStatement：旧实现让每个绑定都用整条语句范围，
    // 改 a 会连带替换掉 b。每个绑定独立范围后，改 a 不应波及 b。
    await writeFile(path.join(root, 'm.ts'), `export const a = 1, b = 2;\n`);
    const ws = await createWorkspace({ root, plugins: [typescriptPlugin()] });
    const resolved = await ws.resolveTarget({
      path: 'm.ts',
      target: { symbol: { kind: 'variable', name: 'a' } },
      expectedMatches: 1,
    });
    assert.equal(resolved.status, 'resolved');
    const tx = await ws.prepareEdit({
      operations: [{ targetId: resolved.target.targetId, operation: { type: 'replace_symbol', replacement: 'a = 100' } }],
    });
    await ws.applyEdit({ transactionId: tx.transactionId });
    const next = await readFile(path.join(root, 'm.ts'), 'utf8');
    assert.ok(next.includes('b = 2'), `sibling binding b must survive: ${next}`);
    assert.ok(next.includes('100'), next);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
