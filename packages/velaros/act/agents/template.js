
// 示例函数按需选用；定义函数不会执行。放入对应入口并显式调用，将需要的返回值交给 output。
import { profiles, start, resume, status, wait, cancel, send, reply } from 'velaros:agents'
// observe / execute：先查看宿主开放的配置、模块与预算，name 直接传给 start。
async function availableProfiles() { return profiles() }
// execute：profile 使用宿主开放的名称；materials 是已有材料引用；stores 为 [{store:空间ID,read:[前缀],write:[前缀]}]，必须在自己的授权范围内，且每个 write 前缀都必须被该项 read 覆盖（例如 read:["input/","result/"], write:["result/"]）。
async function dispatch(profile,materials,stores) { return start({task:'调查失败原因并返回证据',profile,materials,stores,writes:[]}) }
// observe / execute：读取句柄状态。
async function progress(id) { return status({id}) }
// 以下只允许 execute；wait 不额外调用模型。
async function collect(id) { return wait({id}) }
async function continueWork(id) { return resume({id,input:'请继续核对未查清的部分'}) }
async function steer(id) { return send({id,input:'优先检查启动路径'}) }
async function stop(id) { return cancel({id}) }

// wait 遇到子任务提问即返回；job.pending 的每项包含 id/runId/kind/message。
async function answerRequest(id,requestId,value) { return reply({id,requestId,value}) }
// 环境只在收束后的安全边界替换；同一子会话、材料和已用预算继续保留。
async function implement(id,profile,writes,stores) { return resume({id,input:'按批准的计划实施',profile,writes,stores}) }
