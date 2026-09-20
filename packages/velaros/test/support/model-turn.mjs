/** 构造真实结构化协议响应，省略的脚本区域显式为 null。 */
export function turn(submission={},message='') {return {type:'output',value:{message,observe:null,execute:null,...submission}}}
/** 模型交还控制的完整响应，完成状态仍由 Runtime 验收。 */
export async function* done(message='') {yield turn({},message);yield {type:'finish',reason:'stop'}}
