/** 判断未知值是否为有限正数；保持 html-artifacts 包零运行时依赖。 */
export function isFinitePositiveNumber(value: unknown): value is number {
  // @arch-guard:suspend code-style/forbid-raw-runtime-type-guards 理由：零依赖包在边界集中定义本地数值守卫，不能反向依赖 core。
  // @arch-guard:suspend code-style/prefer-is-finite-number-guard 理由：html-artifacts 保持零运行时依赖，无法导入 core 的 isFiniteNumber。
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}
