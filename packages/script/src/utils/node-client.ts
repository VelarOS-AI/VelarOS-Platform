import ts from 'typescript'

import { NodeEnvironmentVariables, NodeExecutionLimits } from '../contract/constants.js'

/** 每次执行共享一个标准 ESM 传输模块，短期凭据只从当前子进程环境读取。 */
export function nodeCapabilityBridge(): string {
  return `import {request} from 'node:http';
export const invoke = (namespace, operation, input) => new Promise((resolve, reject) => {
  const req = request({socketPath:process.env[${JSON.stringify(NodeEnvironmentVariables.socket.name)}], path:'/', method:'POST', headers:{authorization:'Bearer '+process.env[${JSON.stringify(NodeEnvironmentVariables.token.name)}], 'content-type':'application/json'}}, res => {
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
  req.on('error', reject);
  req.end(JSON.stringify({namespace, operation, input}));
});
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
