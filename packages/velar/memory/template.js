// velar:memory 的代码模版：日常最常用的几种写法，一段一个函数。只是示例——按你的需要改写、只取其中几行都行，不必照着写。
// 读写都只在当前空间；你写下的是你的记录，不是用户的确认。
import { archive, get, save, search } from 'velar:memory'

// 记下用户明确说过的偏好：kind、title、content 三样就够。
async function rememberPreference(title = '回复风格', content = '用户偏好简洁中文回答，先给结论。') {
  const saved = await save({ kind: 'preference', title, content })
  return { id: saved.memoryId, isNew: saved.inserted, availability: saved.availability }
}

// 按话题召回：看标题、内容、可信度和来源——sourceTypes 里是 agent_tool 的是 agent 自己写的。
async function recall(query = '记忆系统重构') {
  const found = await search({ query, limit: 8 })
  return found.memories.map((memory) => ({ id: memory.id, title: memory.title, value: memory.value, confidence: memory.confidence, from: memory.sourceTypes }))
}

// 看用户画像：只要偏好、反馈与兴趣。
async function profile() {
  const found = await search({ categories: ['preference', 'feedback', 'interest'], limit: 12 })
  return found.memories.map((memory) => `${memory.title}：${memory.summary}`)
}

// 看最近记了什么：不给话题。
async function recent() {
  const found = await search({})
  return found.memories.map((memory) => memory.title)
}

// 连已归档的一起找：deep 为真时，退出日常召回的也翻出来。
async function includingArchived(query = '之前暂停的任务') {
  const found = await search({ query, deep: true })
  return found.memories.map((memory) => memory.title)
}

// 按 id 读一条的内容与来源：id 来自 search 的结果，或环境里给的记忆 id。
async function readOne(id) {
  const memory = await get({ id })
  return { title: memory.title, value: memory.value, sources: memory.sources }
}

// 归档过时的一条：archived 为假就是没归档成，要如实告诉用户。
async function retire(id) {
  const result = await archive({ id })
  return result.archived ? '已归档：退出日常召回，内容还在，deep 能找到' : '没有归档成：这条所在的记忆目录是只读的'
}
