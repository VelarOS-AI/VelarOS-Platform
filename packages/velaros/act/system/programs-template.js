// 发布只检查并归档；用不可变 sourceRef 经正常 execute 入口运行，每次传 input/blobs。
import { programs } from 'velaros:system'
const { list, describe, publish } = programs

async function discoverPrograms(query = '') {
  return list({ query, limit: 20 })
}

async function programVersion(name = 'text-summary') {
  return describe({ name })
}

async function publishSummary() {
  return publish({
    name: 'text-summary',
    purpose: '汇总本次输入的标题与正文大小',
    inputDescription: 'input.title 是标题；blobs.text 是完整正文。',
    source: "import { output } from 'velaros'; import { input, blobs } from 'velaros:program'; output({ title: input.title, chars: blobs.text.length }, { key: 'summary' });",
  })
}

// 将 publishSummary 或 programVersion 的 sourceRef 原样交给本帧 execute 控制头：
// execute({ sourceRef, input: { title: '本次标题' }, blobs: { text: '本次正文' } })
// 运行回执仍要检查；源码、调用、输出和失败保持原有审计身份。
