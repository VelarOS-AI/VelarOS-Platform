import type { EventDeliveryOptions } from '../contract/requires.js'

/** 单个有序流的交付屏障；落盘与传输由宿主注入。 */
export interface EventDeliveryApi<Value> {
 /** 接收可结构化克隆的事件；持久化成功且前序事件已交付后才完成。 */
 append(value:Value):Promise<void>
 /** 等待调用前已接收的全部写入和交付，失败仍向调用者抛出。 */
 flush():Promise<void>
 /** 封闭输入并排空已接收事件；重复关闭安全，失败不会变成成功。 */
 close():Promise<void>
}

/** 持久写入可合批进行；交付严格串行，任何失败使本流停止继续交付。 */
class EventDelivery<Value,Receipt> implements EventDeliveryApi<Value> {
 private tail:Promise<void>=Promise.resolve()
 private failure?:{error:unknown}
 private closed=false
 public constructor(private readonly options:EventDeliveryOptions<Value,Receipt>){}
 public append(value:Value):Promise<void>{
  if(this.closed)return Promise.reject(new Error('事件交付已经关闭'))
  if(this.failure)return Promise.reject(this.failure.error)
  // 在返回调用方之前冻结输入，避免排队期间宿主修改原对象。
  let snapshot:Promise<Value>
  try{snapshot=Promise.resolve(structuredClone(value))}catch(error){snapshot=Promise.reject(error)}
  // 写入按 append 顺序启动，但不等待前次写入，保留宿主的批量落盘能力。
  const write=snapshot.then(saved=>this.options.persist(saved)).then(
   receipt=>({ok:true as const,receipt}),error=>({ok:false as const,error})
  )
  const task=this.tail.then(async()=>{
   const result=await write
   if(this.failure)throw this.failure.error
   if(!result.ok)throw result.error
   await this.options.deliver(result.receipt)
  })
  // 此 tail 永不拒绝，后续任务仍须等待自己的在途写入，然后交出首个失败。
  this.tail=task.then(()=>{},error=>{this.failure??={error}})
  return task
 }
 public async flush():Promise<void>{await this.tail;if(this.failure)throw this.failure.error}
 public close():Promise<void>{this.closed=true;return this.flush()}
}
/** 创建有序交付通道；只负责当前流的屏障，历史回放和确认裁剪由宿主存储负责。 */
export function createEventDelivery<Value,Receipt>(options:EventDeliveryOptions<Value,Receipt>):EventDeliveryApi<Value>{return new EventDelivery(options)}
