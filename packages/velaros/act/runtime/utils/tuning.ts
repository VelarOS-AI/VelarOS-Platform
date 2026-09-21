

/** Runtime 的缺省调节参数；宿主显式配置仍优先。 */
export const ActRuntimeTuning=Object.freeze({
/** 一次模型工具交付最多附带的已保存脚本数。 */
deliveryScripts:16,
/** 专项工具在 runtime 分区中保留的事实目录上限。 */
modelToolContextChars:16000,
/** 同一观察代码连续失败后暂停自动重跑的次数。 */
observationFailures:3,
/** 请求与追踪材料默认字符上限。 */
frameChars:1000000,
/** 原始归档单页读取字符上限。 */
readChars:60000,
/** 工作笔记默认分页条目数。 */
workspacePage:32,
/** 近期记录默认最大页长度。 */
historyPage:64,
/** 历史目录默认单页条目数。 */
historyDefaultPage:32,
/** 协议增量替换条目上限。 */
edits:128,
/** 搜索允许提交的来源标识上限。 */
searchSources:64,
/** 搜索初始锚点上限。 */
searchAnchors:32,
/** 协议修复默认次数。 */
protocolRepairs:2,
})
