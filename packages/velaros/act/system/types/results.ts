/**
 * 结果在当前逻辑任务中的可见期限。
 * @AgentView
 * 执行结果的自动展示期限：成功业务回合数（1 到 32）；'segment' 保留到该结果随历史封段，'task' 保留到任务结束。主动释放仍立即生效，正文展示受上下文容量约束。
 */
export type ScriptRetention = number | 'segment' | 'task'
