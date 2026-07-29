import { AppError } from '../error'

/**
 * 进程内单例基类。
 *
 * 继承它的 store/service 应该只导出一个实例；如果有人再次 new 同一类型，
 * 构造函数会直接抛错，避免数据库 / 配置 / 路径解析等全局资源出现多个实例。
 *
 * 该基类的 `instantiatedTypes` 静态集合必须在整个进程内是同一个引用，
 * 否则跨包的"同一个类只能实例化一次"语义会被悄悄破坏。
 * 因此**只能从这里导出 Singleton**，所有 monorepo 内的 store/service 都必须
 * 直接 `import { Singleton } from '@velaros-ai/core/utils/Singleton'`，不要再放任何本地副本。
 */
abstract class Singleton {
  private static readonly instantiatedTypes = new Set<Function>()

  protected constructor() {
    const singletonType = new.target
    if (!singletonType) return

    if (Singleton.instantiatedTypes.has(singletonType)) {
      throw new AppError(
        'UNKNOWN',
        `${singletonType.name} is a singleton and has already been instantiated. Import the exported instance instead of calling new ${singletonType.name}().`,
      )
    }

    Singleton.instantiatedTypes.add(singletonType)
  }
}

export { Singleton }
