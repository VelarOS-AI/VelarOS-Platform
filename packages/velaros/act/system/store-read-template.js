import {output} from 'velaros'
import {store} from 'velaros:system'
const {list,keys,get,watch,events,subscribe,ack,read}=store
// observe / execute：仅发现当前获配目录；分页由 nextAfter 继续。
async function discover() { output(await list({limit:20})) }
// runtime.stores.active 稳定携带本任务使用或获配空间；omitted > 0 时分页查看。
async function activeStores(after) { output(await list({active:true,after,limit:20})) }
async function inspect(id,key) { output(await get({store:id,key})) }
async function directory(id,prefix) { output(await keys({store:id,prefix,limit:20})) }
// execute：先关注后读基线。变化在 runtime.stores 中，总预算由 Runtime 管理。
async function follow(id,key) { await watch({store:id,keys:[key]}); output(await get({store:id,key})) }
async function stopFollowing(id) { output(await watch({store:id,keys:[]})) }

// execute：先订阅；after:0 可显式补读保留窗口，gap 表示更早消息已缺失。
async function listen(id,topic) { return subscribe({store:id,topics:[topic]}) }
// observe / execute：事件正文按需读取；自动上下文只包含元数据和待处理数量。
async function inbox(id,after) { output(await events({store:id,after,limit:20})) }
// execute：完成业务处理后确认精确消息；系统的投递确认不代替业务确认。
async function processed(id,ids) { return ack({store:id,ids}) }
async function material(id,key,offset) { output(await read({store:id,key,offset,limit:8000})) }
