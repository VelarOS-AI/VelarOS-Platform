/** macOS 验证使用默认拒绝策略；文件副本只读，临时工作区可写，网络和进程派生均保持拒绝。 */
export function nodeValidationProfile(runtime: string, input: string, working: string): string {
  const literal = (path: string) => `(literal ${JSON.stringify(path)})`
  const subtree = (path: string) => `(subpath ${JSON.stringify(path)})`
  return [
    '(version 1)',
    '(deny default)',
    '(import "dyld-support.sb")',
    `(allow process-exec ${literal(runtime)})`,
    '(allow file-read-metadata)',
    `(allow file-read-data ${subtree('/System/Library')} ${subtree('/usr/lib')} ${literal(runtime)} ${subtree(input)} ${subtree(working)} ${literal('/dev/urandom')} ${literal('/dev/random')} ${literal('/dev/null')})`,
    `(allow file-write* ${subtree(working)} ${literal('/dev/null')})`,
    '(allow sysctl-read)',
    '(allow dynamic-code-generation)',
    `(allow file-map-executable ${literal(runtime)} ${subtree('/System/Library')} ${subtree('/usr/lib')})`,
    `(allow file-read* file-map-executable ${subtree('/System/Cryptexes')} ${subtree('/System/Volumes/Preboot/Cryptexes')})`,
  ].join('\n')
}

/** 预检自身只接触本次创建的探针文件；对外进程信号使用零信号做权限检查。 */
export function nodeValidationPreflight(outside: string, input: string): string {
  return `import assert from 'node:assert/strict';
import fs from 'node:fs'; import cp from 'node:child_process'; import net from 'node:net';
const denied = action => { let code; try { action() } catch(error) { code=error.code } assert(['EPERM','EACCES'].includes(code), 'Required OS boundary unavailable') };
denied(()=>fs.readFileSync(${JSON.stringify(outside)}));
denied(()=>fs.writeFileSync(${JSON.stringify(outside)},'changed'));
denied(()=>fs.writeFileSync(${JSON.stringify(input)},'changed'));
denied(()=>process.kill(process.ppid,0));
const child=cp.spawnSync(process.execPath,['-e','process.exit(0)']);
assert(['EPERM','EACCES'].includes(child.error?.code),'Child-process boundary unavailable');
const network=await new Promise(resolve=>{const socket=net.createConnection({host:'127.0.0.1',port:9});socket.on('connect',()=>{socket.destroy();resolve('ALLOWED')});socket.on('error',error=>resolve(error.code));socket.setTimeout(500,()=>{socket.destroy();resolve('TIMEOUT')})});
assert(['EPERM','EACCES'].includes(network),'Network boundary unavailable');
fs.writeFileSync('probe-scratch','allowed'); assert.equal(fs.readFileSync('probe-scratch','utf8'),'allowed');
console.log(JSON.stringify({node:process.version,boundaries:true}));`
}

/** 截断不拼出不完整 UTF-8 字符，返回的内容总字节不超过宿主上限。 */
export function nodeValidationOutput(stdout: string, stderr: string, maxBytes: number) {
  const take = (value: string, limit: number) =>
    new TextDecoder().decode(Buffer.from(value).subarray(0, Math.max(0, limit)), { stream: true })
  const out = take(stdout, maxBytes)
  const err = take(stderr, maxBytes - Buffer.byteLength(out))
  return { stdout: out, stderr: err, truncated: out !== stdout || err !== stderr }
}
