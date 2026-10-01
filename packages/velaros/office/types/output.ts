/** 准备阶段固定的输出位置与覆盖授权；最终发布前仍需复核真实路径。 */
export interface OfficePreparedOutput {
  path: string
  created: boolean
  rootPath: string
  target: string
  overwrite: boolean
}
