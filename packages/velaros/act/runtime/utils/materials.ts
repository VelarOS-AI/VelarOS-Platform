import type { ContextRef } from "@velaros-ai/context";
import {Log} from '@velaros-ai/core'
import { isArray, isPlainObject } from '@velaros-ai/core'

/** 投影大字段为可召回引用；原始脚本值和归档正文保持不变。 */
export function projectMaterial(text:string,ref:ContextRef,limit:number){
  const size={storedBytes:new TextEncoder().encode(text).byteLength,chars:text.length,unit:'utf16'}
  const reference=(pointer:string,value:unknown)=>({ref,position:pointer,representation:'reference',bodyIncluded:false,chars:JSON.stringify(value).length,storedBytes:new TextEncoder().encode(JSON.stringify(value)).byteLength,items: isArray(value) ? value.length : undefined,read:{module:'velaros:system',export:'memory',operation:'read',ref:ref.id,rangeUnit:'utf16'},reason:'view-budget'})
  if(text.length<=limit)return {text,representation:'full' as const,bodyIncluded:true,size,omitted:[] as string[]}
  const omitted:string[]=[]
  let value:unknown
  try{value=JSON.parse(text)}catch{Log.tag('ActRuntime').debug('materials 已进入异常处理或降级分支');return {text:text.slice(0,limit),representation:'excerpt' as const,bodyIncluded:limit>0,size,omitted:['/']}}
  const shrink=(item:unknown,pointer:string,budget:number):unknown=>{
    if(JSON.stringify(item).length<=budget)return item
    if(isPlainObject(item) && budget>512){
      const entries=Object.entries(item); const share=Math.floor(budget/Math.max(1,entries.length))
      return Object.fromEntries(entries.map(([key,child])=>[key,shrink(child,`${pointer}/${key.replaceAll('~','~0').replaceAll('/','~1')}`,share)]))
    }
    omitted.push(pointer||'/');return reference(pointer||'/',item)
  }
  const projected=JSON.stringify(shrink(value,'',limit))
  if(projected.length>limit)return {text:'',representation:'reference' as const,bodyIncluded:false,size,omitted:['/']}
  return {text:projected,representation:'excerpt' as const,bodyIncluded:true,size,omitted}
}
