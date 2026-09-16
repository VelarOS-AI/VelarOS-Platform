/**
 * 验证器注册处：判据交给谁去判。结果只由这里的验证器说了算，没人判过的一律是未知。
 */
import type { Verifier } from '../contract/requires.js'

/**
 * 一套评测的验证器注册处。id 空串或重复一律当场报错——判据引用不到验证器时必须早失败，
 * 不能跑到一半才发现这一条根本没人判。实例归调用方，一套评测一份。
 */
export interface VerifierRegistryApi {
  /** 注册一个验证器；id 为空或重复当场报错。 */
  register: (id: string, verifier: Verifier) => void
  /** 按 id 取验证器；没有就是 `null`。 */
  get: (id: string) => Verifier | null
  /** 列出已注册的验证器 id，排序后返回。 */
  ids: () => readonly string[]
}

class VerifierRegistry implements VerifierRegistryApi {
  private readonly verifiers = new Map<string, Verifier>()

  public register(id: string, verifier: Verifier): void {
    if (!id.trim()) throw new Error('验证器 id 不能为空')
    if (this.verifiers.has(id)) throw new Error(`这个验证器已经注册过了: ${id}`)
    this.verifiers.set(id, verifier)
  }

  public get(id: string): Verifier | null {
    return this.verifiers.get(id) ?? null
  }

  public ids(): readonly string[] {
    return [...this.verifiers.keys()].sort()
  }
}

/** 开一份空的验证器注册处。 */
export function createVerifierRegistry(): VerifierRegistryApi {
  return new VerifierRegistry()
}
