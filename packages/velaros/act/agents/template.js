
// 示例函数按需选用；定义函数不会执行。放入对应入口并显式调用，将需要的返回值交给 output。
import { profiles, start, resume, status, wait, cancel, send, reply } from 'velaros:agents'
// observe / execute：看宿主给的配置、模块与预算；不选 profile 时 start 用第一个。
async function availableProfiles() { return profiles() }
// execute：task 写清分工、约束和交付要求；Node 子任务自带父输入摘录，materials 可补充其他原文引用。
async function dispatch(materials) { return start({task:'只读调查启动失败的原因，返回已验证的复现步骤、相关文件位置及未查清的问题。',materials}) }
// observe / execute：读取句柄状态。
async function progress(id) { return status({id}) }
// 以下只允许 execute；wait 不额外调用模型。
async function collect(id) { return wait({id}) }
async function continueWork(id) { return resume({id,input:'请继续核对未查清的部分'}) }
async function steer(id) { return send({id,input:'优先检查启动路径'}) }
async function stop(id) { return cancel({id}) }

// wait 遇到子任务提问即返回；job.pending 的每项包含 id/runId/kind/message。
async function answerRequest(id,requestId,value) { return reply({id,requestId,value}) }
// 收束后接着做，可以换一个配置；同一子会话、材料和已用预算继续保留。
async function implement(id,profile) { return resume({id,input:'按批准的计划实施',profile}) }
