import type { KernelModPackDescriptor } from '../../contracts/protocol/mods'

export type KernelModCatalogErrorCode =
  /** 本 Kernel 没有接 ModStore（进程内装配常见），`mods.*` 无从谈起。 */
  | 'MODS_UNAVAILABLE'
  /** 从目录安装失败：目录不存在、清单不合法、入口导不出模块定义…… */
  | 'MOD_INSTALL_FAILED'
  /** 启停一个不在索引里的 pack。 */
  | 'MOD_NOT_FOUND'

/**
 * `mods.*` 这条线上的失败**必须带码**。
 *
 * 没有码的错误在 RPC 那一侧会被统一投影成 `INTERNAL_ERROR` 且标成可重试，原因只留在守护进程
 * 日志里——调用方看到的是「Kernel RPC request failed，可以重试」，重试多少次都一样。
 */
export class KernelModCatalogError extends Error {
  public constructor(
    public readonly code: KernelModCatalogErrorCode,
    message: string,
    public readonly details: Nullable<Readonly<Record<string, unknown>>> = null,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'KernelModCatalogError'
  }
}

/**
 * Runtime port for ModStore management over Kernel RPC.
 *
 * Implemented by the daemon ModStore adapter; KernelService stays free of
 * filesystem/install details.
 */
export interface KernelModCatalog {
  list(): readonly KernelModPackDescriptor[]
  setEnabled(
    id: string,
    enabled: boolean,
  ): Promise<{ readonly ok: boolean; readonly reloadRequired: boolean }>
  installFromDirectory(
    directory: string,
  ): Promise<{
    readonly pack: KernelModPackDescriptor
    readonly reloadRequired: boolean
  }>
}
