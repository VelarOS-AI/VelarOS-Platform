/**
 * 验收测试与实现测试共用的假对象：内核模块注册上下文、假子进程。
 * 放在 spec 下，因为验收测试依赖它们；实现测试也从这里取，不再各抄一份。
 */
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import type {
  KernelModuleActivateContext,
} from '@velaros-ai/kernel'
import type {
  CapabilityToken,
} from '@velaros-ai/kernel/contracts'

/** 捕获内核模块 activate 时注册的服务，测试用来拿到能力服务实例。 */
export function captureService(
  capture: (tokenId: string, service: object) => void,
): KernelModuleActivateContext {
  return {
    registerService<TService extends object>(
      token: CapabilityToken<TService>,
      service: TService,
    ) {
      capture(token.id, service)
      return { dispose() {} }
    },
  } as unknown as KernelModuleActivateContext
}

/** 一个什么都不做的假子进程：有三根管道和事件，没有 pid。 */
export function fakeChild(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid: undefined,
    unref: () => {},
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  }) as unknown as ChildProcess
}
