/**
 * 验收测试与实现测试共用的假对象与探测：一个什么都不做的假子进程、本机有没有进程约束后端。
 * 放在 spec 下，因为验收测试依赖它们；实现测试也从这里取，不再各抄一份。
 */

import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { PassThrough } from 'node:stream'

/** 本机有没有进程约束后端：macOS 的 sandbox-exec 或 Linux 的 bubblewrap；没有就跳过要真跑受约束命令的用例。 */
export const canConfine =
  (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) ||
  (process.platform === 'linux' &&
    ['/usr/bin/bwrap', '/usr/local/bin/bwrap'].some((path) => existsSync(path)))

/** 一个什么都不做的假子进程：有三根管道和事件，没有 pid。受管子进程的期限、信号与收尾拿它来测，不起真进程。 */
export function fakeChild(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid: undefined,
    unref: () => {},
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  }) as unknown as ChildProcess
}
