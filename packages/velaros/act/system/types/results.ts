/**
 * 结果在当前逻辑任务中的可见期限。
 * @AgentView
 * 执行结果的自动展示期限：成功业务回合数（1 到 32），或者 'task' 表示到任务结束。
 */
export type ScriptRetention = number | 'task'
