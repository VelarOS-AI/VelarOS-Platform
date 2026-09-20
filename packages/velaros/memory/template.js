// velaros:memory 的代码模版：日常最常用的几种写法，一段一个函数。只是示例——按你的需要改写、只取其中几行都行，不必照着写。
// 读写都只在当前这一份记忆里；会话开头的索引列着每条的 id、标题与描述，末尾是现有标签。
import { list, remove, save } from 'velaros:memory'

// 记下用户明确说过的偏好：id 自己起；描述写成一眼看得出什么时候用得上的话；标签写这条讲的是什么。
async function rememberPreference() {
  const saved = await save({
    id: 'reply-in-chinese',
    type: 'user',
    title: '汇报用中文',
    description: '写给用户的文字都用中文，先给结论',
    tags: ['汇报', '语言'],
    content: '写给用户的文字一律用中文；命令、路径、报错原文不翻。',
  })
  return saved.created ? `记下了 ${saved.id}` : `更新了 ${saved.id}`
}

// 改一条已有的：按 id 取出来，改完用同一个 id 整条写回。
async function addReason(id = 'reply-in-chinese', reason = '用户明确要求过。') {
  const memory = (await list()).find((entry) => entry.id === id)
  if (!memory) return `没有 ${id} 这一条`
  await save({ ...memory, content: `${memory.content}\n为什么：${reason}` })
  return `给 ${id} 补上了原因`
}

// 按标签找；标签没打全时，再用正文里的关键词兜底。
async function findByTopic(tag = '汇报', keyword = /汇报|中文/) {
  const memories = await list()
  return memories
    .filter((memory) => memory.tags.includes(tag) || keyword.test(memory.content))
    .map((memory) => ({ id: memory.id, title: memory.title, content: memory.content }))
}

// 删掉记错或过时的一条：真删，删了就没了。
async function forget(id = 'reply-in-chinese') {
  const result = await remove({ id })
  return result.removed ? `删掉了 ${id}` : `本来就没有 ${id}`
}
