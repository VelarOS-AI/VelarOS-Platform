/**
 * 注入面：宿主往命令行里塞的东西只有一样——命名空间执行器。
 * 产品用 `createVelarosCliRouter({ namespaces })` 注册自己的运维命名空间，本包不扫 PATH、不维护领域白名单。
 */

import type { VelarosCliNamespaceRunResult, VelarosCliRunOptions } from '../types/cli.js'

/**
 * 宿主注册进来的一个运维命名空间：拿到去掉命名空间名之后的参数，自己跑完给出可打印结果。
 * 方向是单向的——路由器调它，它不认识也不回调路由器；抛出的异常由路由器收成失败信封。
 */
export type VelarosCliNamespaceRunner = (
  argv: readonly string[],
  options: VelarosCliRunOptions,
) => VelarosCliNamespaceRunResult | Promise<VelarosCliNamespaceRunResult>
