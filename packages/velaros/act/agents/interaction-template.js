
// 示例函数按需选用；定义函数不会执行。放入对应入口并显式调用，将需要的返回值交给 output。
import { ask, capability,confirm } from 'velaros:interaction'
// 所有操作均只允许 execute：回答绑定当前运行和交互身份。
async function clarify() { return ask({message:'请补充目标文件的位置。'}) }
// 确认答案交给模型判断，具体写操作仍走能力权限检查。
async function approval() { return confirm({message:'是否应用已展示的修改？'}) }

// 子任务请求送达父任务；主线请求送达宿主。回答本身不授予权限。
async function requestCapability() { return capability({message:'下一阶段需要写入工作区',detail:{reason:'实施已经核实的修改'}}) }
