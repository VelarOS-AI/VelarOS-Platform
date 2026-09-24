// 示例函数按需选用；定义函数不会执行。放入对应入口并显式调用，将需要的返回值交给 output。
import { ask, capability,confirm } from 'velaros:interaction'
// 所有操作均只允许 execute：回答绑定当前运行和交互身份。
async function clarify() { return ask({message:'请补充目标文件的位置。'}) }
// 只有几个可能的答案时给选项，对方点选；回答的 choices 是选中的 id，allowText 时自己写的在 text。
async function choose() { return ask({message:'改动先应用到哪个环境？',options:[{id:'staging',label:'预发环境',recommended:true},{id:'production',label:'生产环境'}],allowText:true}) }
// 一次要好几项时给表单；回答的 values 按字段 id 给出。
async function collect() { return ask({message:'请填写发布信息。',fields:[{id:'version',label:'版本号',kind:'text',required:true},{id:'notify',label:'通知团队',kind:'boolean'}]}) }
// 确认返回 approved 与不同意的理由；具体写操作仍走能力权限检查。
async function approval() { const {approved,reason} = await confirm({message:'是否应用已展示的修改？'}); return approved ? '已同意' : `未同意：${reason ?? '没有给理由'}` }

// 子任务请求送达父任务；主线请求送达宿主。回答本身不授予权限。
async function requestCapability() { return capability({message:'下一阶段需要写入工作区',detail:{reason:'实施已经核实的修改'}}) }
