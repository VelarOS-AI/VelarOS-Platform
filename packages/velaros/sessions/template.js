// 现有会话之间分工；先用 list 查真实身份，不从标题推断权限或自动创建会话。
// 对方看不到当前对话，task、message 应写明范围、交付要求及必要资源路径。
import { ask, list, tell } from 'velaros:sessions'

// 指定真实会话处理任务；waiting 表示需要补充回答，后续继续使用相同 session。
async function delegateTask(session, task) {
  const reply = await ask({ to: session, task })
  if (reply.status === 'waiting') return { session: reply.session, question: reply.answer }
  return { session: reply.session, status: reply.status, answer: reply.answer, reason: reply.reason }
}

// 回答现有任务的问题，继续原来的工作。
async function answerQuestion(session, answer) {
  return ask({ to: session, task: `你刚才问题的答复是：${answer}。按此继续完成任务并交回结果。` })
}

// 独立任务可并行提交；两个身份应来自 list，且不能是自己。
async function compareTasks(left, right) {
  const [first, second] = await Promise.all([
    ask({ to: left, task: '核对已分配范围中的接口定义，交回方法、路径与参数表。' }),
    ask({ to: right, task: '核对已分配范围中的接口实现，交回方法、路径与参数表。' }),
  ])
  return { first: first.answer, second: second.answer }
}

// 只给正在工作的其他会话追加引导；查询状态是快照，投递仍以宿主准入为准。
async function notifyRunning(message) {
  const peers = (await list()).filter((peer) => !peer.self && peer.running)
  return Promise.all(peers.map((peer) => tell({ to: peer.id, message })))
}
