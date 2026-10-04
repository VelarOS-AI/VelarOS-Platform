import { NodeEnvironmentVariables, NodeExecutionLimits } from '../contract/constants.js'

/** 生成普通 ESM 客户端；目录只含协议实现，短期凭据只来自本次子进程环境。 */
export function nodeCapabilityClient(namespace: string, operations: readonly string[]): string {
  return `import {request} from 'node:http';
const invoke = (operation, input) => new Promise((resolve, reject) => {
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
  req.end(JSON.stringify({namespace:${JSON.stringify(namespace)}, operation, input}));
});
${operations.map((operation, index) => `const op${index} = input => invoke(${JSON.stringify(operation)}, input);\nexport {op${index} as ${JSON.stringify(operation)}};`).join('\n')}
`
}
