import {output} from 'velaros'
import {store} from 'velaros:system'
const {create,list,keys,get,set,remove,watch,events,subscribe,ack,read,publish,share}=store
// execute：创建持久空间；返回 id 跨脚本、会话重建保持稳定。
async function prepare(name) { output(await create({name})) }
// observe / execute：仅发现当前获配目录；分页由 nextAfter 继续。
async function discover() { output(await list({limit:20})) }
// runtime.stores.active 稳定携带本任务使用或获配空间；omitted > 0 时分页查看。
async function activeStores(after) { output(await list({active:true,after,limit:20})) }
async function inspect(id,key) { output(await get({store:id,key})) }
async function directory(id,prefix) { output(await keys({store:id,prefix,limit:20})) }
// execute：先关注后读基线。变化在 runtime.stores 中，总预算由 Runtime 管理。
async function follow(id,key) { await watch({store:id,keys:[key]}); output(await get({store:id,key})) }
async function replace(id,key,value) { const current=await get({store:id,key}); output(await set({store:id,key,baseRevision:current?.revision??0,value})) }
async function erase(id,key) { const current=await get({store:id,key}); if(current)output(await remove({store:id,key,baseRevision:current.revision})) }
async function stopFollowing(id) { output(await watch({store:id,keys:[]})) }

// execute：先订阅；after:0 可显式补读保留窗口，gap 表示更早消息已缺失。
async function listen(id,topic) { return subscribe({store:id,topics:[topic]}) }
// observe / execute：事件正文按需读取；自动上下文只包含元数据和待处理数量。
async function inbox(id,after) { output(await events({store:id,after,limit:20})) }
// execute：完成业务处理后确认精确消息；系统的投递确认不代替业务确认。
async function processed(id,ids) { return ack({store:id,ids}) }
async function material(id,key,offset) { output(await read({store:id,key,offset,limit:8000})) }

// execute：独立消息逐条保存；主题和对象键复用相同读写前缀权限。
async function notify(id,topic,value) { output(await publish({store:id,topic,value})) }
// 原文复制到该键的共享空间，接收者凭键权限读取，不授予源会话访问权。
async function shareEvidence(id,key,ref,baseRevision) { return share({store:id,key,ref,baseRevision}) }
// 更新与通知同一事务提交；不能把外部操作包装成全局事务。
async function commitAndNotify(id,key,value,baseRevision,topic) { return set({store:id,key,value,baseRevision,event:{topic,value:{key}}}) }
