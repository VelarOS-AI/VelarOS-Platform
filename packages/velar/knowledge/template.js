// velar:knowledge 的代码模版：日常最常用的几种写法，一段一个函数。只是示例——按你的需要改写、只取其中几行都行，不必照着写。
// 不写 workspaceRoot 就是当前空间的工作区；知道路径就直接读文件，检索是找「不知道在哪」的知识。
import { diagnostics, search, sync } from 'velar:knowledge'

// 搜一句话：命中按相关度排好，先看路径、标题与命中处的片段。
async function find(query = '登录态怎么刷新') {
  const found = await search({ query })
  return found.results.map((hit) => ({ path: hit.path, title: hit.title, snippet: hit.snippet, score: hit.score }))
}

// 只搜某类来源：代码知识配上符号提示，路径提示抬高相关目录的排序。
async function findInCode(query = 'token 刷新', symbol = 'refreshToken', directory = 'src/auth') {
  const found = await search({ query, sourceKinds: ['code'], symbolHints: [symbol], pathHints: [directory], limit: 5 })
  return found.results.map((hit) => `${hit.path}：${hit.snippet}`)
}

// 读最相关那篇的全文：content 就是整份正文。
async function readBest(query = '部署流程') {
  const { results } = await search({ query, limit: 1 })
  return results.length === 0 ? '没有命中' : { path: results[0].path, content: results[0].content }
}

// 刚改完一批文档、想马上搜到：先强制同步，再搜。
async function refreshThenFind(query = '新加的配置项') {
  const synced = await sync({ force: true })
  const found = await search({ query })
  return { indexed: synced.upserted + synced.reindexed, count: found.count }
}

// 零命中时看 autoSync：它出现就是刚为这个工作区补过索引、重搜过还是没有——真没有，不要再 sync 重试。
// indexIssues 里 actionable 的问题（比如嵌入凭据坏了）照 guidance 告诉用户。
async function whyNothing(query = '一个没人写过的词') {
  const found = await search({ query })
  return { count: found.count, autoSync: found.autoSync ?? null, issues: found.indexIssues.map((issue) => issue.guidance) }
}

// 看索引健康：失败、过期的有多少，当前嵌入模型还有多少没覆盖（没覆盖的只能走全文检索）。
async function health() {
  const report = await diagnostics()
  return {
    total: report.totalDocuments,
    failed: report.failedDocuments,
    outdated: report.outdatedDocuments,
    withoutVectors: report.activeProfileMissingDocuments,
    embedding: `${report.embedding.provider}/${report.embedding.model}`,
  }
}
