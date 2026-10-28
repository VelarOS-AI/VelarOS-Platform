import ts from 'typescript'

import { isEmpty } from '@velaros-ai/core'

import { NodeEnvironmentVariables, NodeExecutionLimits } from '../contract/constants.js'

import { sliceModuleExports } from './compiler.js'

/** 每次执行共享一个标准 ESM 传输模块，短期凭据只从当前子进程环境读取。 */
export function nodeCapabilityBridge(): string {
  return `import {request} from 'node:http';
const sockets = new Set();
export const releaseCalls = () => { for (const socket of sockets) socket.unref(); };
export const send = (path, input) => new Promise((resolve, reject) => {
  const req = request({socketPath:process.env[${JSON.stringify(NodeEnvironmentVariables.socket.name)}], path, method:'POST', headers:{authorization:'Bearer '+process.env[${JSON.stringify(NodeEnvironmentVariables.token.name)}], 'content-type':'application/json'}}, res => {
    let body = '', size = 0;
    res.setEncoding('utf8');
    res.on('data', chunk => { size += Buffer.byteLength(chunk); if (size > ${NodeExecutionLimits.responseBytes}) res.destroy(); else body += chunk; });
    res.on('error', reject);
    res.on('end', () => { try {
      const result = JSON.parse(body);
      if (result.error) reject(Object.assign(new globalThis.Error(result.error.message), {code:result.error.code}));
      else if (res.statusCode !== 200) reject(new globalThis.Error('Host call failed: '+res.statusCode));
      else resolve(result.value);
    } catch (error) { reject(error); } });
  });
  if (path === '/') req.on('socket', socket => { if (!sockets.has(socket)) { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); } });
  req.on('error', reject);
  req.end(JSON.stringify(input));
});
export const invoke = async (namespace, operation, input) => {
  try {return await send('/', {namespace, operation, input});}
  catch(error) {throw Object.assign(new globalThis.Error(error.message, {cause:error}), {code:error.code});}
};
`
}

/** 能力客户端只有普通导出，模型读取文件时不必重复接收传输实现。 */
export function nodeCapabilityClient(namespace: string, operations: readonly string[]): string {
  return `import {invoke} from './bridge.mjs';\n${operations
    .map(
      (operation, index) =>
        `const op${index} = input => invoke(${JSON.stringify(namespace)}, ${JSON.stringify(operation)}, input);\nexport {op${index} as ${JSON.stringify(operation)}};`
    )
    .join('\n')}\n`
}

/** 同源声明转为普通文件模块；保留注释、导出与全部依赖类型，不维护第二份操作合同。 */
export function nodeCapabilityDeclarations(declarations: string, namespace: string): string {
  const file = ts.createSourceFile(
    'host.d.ts',
    declarations,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  return file.statements
    .map((statement) => {
      if (
        ts.isModuleDeclaration(statement) &&
        ts.isStringLiteral(statement.name) &&
        statement.name.text === namespace &&
        statement.body &&
        ts.isModuleBlock(statement.body)
      )
        return (
          declarations.slice(statement.getFullStart(), statement.getStart(file)) +
          statement.body.statements.map((member) => member.getFullText(file)).join('\n')
        )
      return statement.getFullText(file)
    })
    .join('\n')
}

/** 从同一声明切出操作及传递类型闭包；注释和签名逐字保留，不另写能力文档。 */
export function nodeOperationDeclarations(
  declarations: string,
  namespace: string,
  operations: readonly string[]
): Readonly<Record<string, string>> {
  const flattened = nodeCapabilityDeclarations(declarations, namespace)
  const file = ts.createSourceFile(
    'operations.d.ts',
    flattened,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  const docs: Record<string, string> = Object.create(null)
  for (const name of operations) {
    const methods = file.statements.filter(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === name
    )
    if (isEmpty(methods)) continue
    const selected = sliceModuleExports(declarations, namespace, [name]).declarations
    if (!selected) continue
    const method = methods[0]!
    const required = method.parameters.filter(
      (parameter) => !parameter.questionToken && !parameter.initializer
    )
    const args = required.map((parameter) => parameter.name.getText(file)).join(', ')
    const example = `/** 调用示例${!isEmpty(required) ? '（参数按上述声明填写）' : ''}：\n * import * as capability from ${JSON.stringify(namespace)};\n * console.log(await capability[${JSON.stringify(name)}](${args}));\n */`
    docs[name] = `${nodeCapabilityDeclarations(selected, namespace)}\n\n${example}\n`
  }
  return docs
}
