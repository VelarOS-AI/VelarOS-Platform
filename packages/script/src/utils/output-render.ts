import { createHash } from 'node:crypto'

import { isArray, isEmpty, isObject, isString, stringifyPretty, toOptional } from '@velaros-ai/core'

import { ScriptOutputLimits } from '../contract/constants.js'
import type { ScriptOutputBlock, ScriptOutputCapture, ScriptOutputManifest, ScriptOutputPresentation, ScriptOutputProjection, ScriptOutputSummary, ScriptOutputView } from '../types/output.js'

/** 原值指纹不包含执行号和采集时间，用于严格绑定摘要。 */
export function outputContentHash(value:unknown):string {return createHash('sha256').update(JSON.stringify(value)).digest('hex')}

/** 将单个 JSON Pointer 解析为自己的数据属性，不访问原型。 */
function selectPointer(value:unknown,path:string):{found:boolean;value?:unknown}{
  let current=value
  for(const key of isEmpty(path)?[]:path.slice(1).split('/').map(p=>p.replaceAll('~1','/').replaceAll('~0','~'))){
    if(!current||!isObject(current) ||!Object.hasOwn(current,key))return {found:false}
    current=Reflect.get(current,key)
  }
  return {found:true,value:current}
}

/** 按类型选择完整条目或完整行；预算不足返回引用，不构造半个 JSON。 */
function renderBlock(block:ScriptOutputBlock,index:number,view:ScriptOutputView,ref:string,budget:number,summaries:readonly ScriptOutputSummary[],taskRevision:string):ScriptOutputPresentation {
  const type=block.options.type??(isString(block.value)?'text':isArray(block.value)?'list':'json')
  const item:ScriptOutputPresentation={key:block.key,type,purpose:block.options.purpose,language:block.options.language,contentHash:outputContentHash(block.value),representation:'reference',text:'',bodyIncluded:false,rawRef:ref,pointer:`/output/blocks/${index}/value`,totalChars:block.chars,totalItems: isArray(block.value) ? block.value.length : undefined}
  const reference=(reason:string,selection?:unknown)=>({...item,reason,selection: toOptional(selection)})
  const cap=Math.min(budget,view.maxChars??budget)
  if(view.mode==='reference'||cap===0)return reference(view.mode==='reference'?'source-policy':'view-budget')
  if(type==='image'||type==='file'){
    const data=block.value as Record<string,unknown>;const info=Object.fromEntries(['name','label','mediaType','bytes','ref'].filter(key=>Object.hasOwn(data,key)).map(key=>[key,isString(data[key])?(data[key] as string).slice(0,500):data[key]]))
    return reference(type==='image'?'native-attachment-required':'file-reference',info)
  }
  if(view.mode==='summary'){
    const summary=summaries.find(s=>s.key===block.key&&s.contentHash===item.contentHash&&s.taskRevision===taskRevision)
    return summary&&summary.text.length<=cap?{...item,representation:'summary',text:summary.text,bodyIncluded:true,reason:'model-interpretation'}:reference(summary?'summary-budget':'summary-unavailable')
  }
  let selected=block.value;let selection:unknown;let partial=false
  if(view.paths){
    const fields=view.paths.map(path=>({path,...selectPointer(selected,path)}));selected={fields};selection={paths:view.paths,missing:fields.filter(f=>!f.found).map(f=>f.path)};partial=true
  }else if(isArray(selected)){
    const total=selected.length;const count=Math.min(total,view.maxItems??total);const start=view.edge==='tail'?total-count:0
    selected=selected.slice(start,start+count);selection={from:start,shown:count,total};partial=count<total
  }else if(isString(selected)&&view.lines){
    const lines=selected.split('\n');const [start,end]=view.lines;selected=lines.slice(start-1,end).join('\n');selection={lines:[start,Math.min(end,lines.length)],totalLines:lines.length,missing:start>lines.length};partial=start>1||end<lines.length
  }
  const stringify=(v:unknown)=>(type==='text'||type==='code')&&isString(v)?v:stringifyPretty(v)
  let text=stringify(selected)
  if(view.mode==='full'&&(partial||text.length>cap))return reference('full-unavailable',selection)
  if(text.length>cap){
    partial=true
    if(isArray(selected)){
      const values=selected;let low=0; let high=values.length
      while(low<high){const mid=Math.ceil((low+high)/2);const part=view.edge==='tail'?values.slice(-mid):values.slice(0,mid);if(stringify(part).length<=cap)low=mid;else high=mid-1}
      if(low===0)return reference('view-budget',selection)
      const offset=(selection as {from:number}).from+(view.edge==='tail'?values.length-low:0)
      selected=view.edge==='tail'?values.slice(-low):values.slice(0,low);text=stringify(selected);selection={from:offset,shown:low,total:(block.value as unknown[]).length}
    }else if(isString(selected)&&(type==='text'||type==='code')){
      const lines=selected.split('\n');const kept:string[]=[];let chars=0
      for(const line of view.edge==='tail'?[...lines].reverse():lines){if(chars+line.length+(!isEmpty(kept)?1:0)>cap)break;kept.push(line);chars+=line.length+(kept.length>1?1:0)}
      if(isEmpty(kept))return reference('line-exceeds-budget',selection)
      text=(view.edge==='tail'?kept.reverse():kept).join('\n');selection={...selection as object,shownLines:kept.length,edge:view.edge??'head',omittedLines:lines.length-kept.length}
    }else{
      if(!selected||!isObject(selected) )return reference('view-budget',selection)
      const entries=Object.entries(selected);const share=Math.floor(cap/Math.max(1,entries.length))
      selected=Object.fromEntries(entries.map(([key,value])=>[key,JSON.stringify(value).length<=share?value:{representation:'reference',rawRef:ref,chars:JSON.stringify(value).length}]))
      text=stringify(selected);if(text.length>cap)return reference('view-budget',selection)
    }
  }
  return {...item,representation:partial?'excerpt':'full',text,bodyIncluded:true,selection: toOptional(selection),reason: partial ? 'source-selection-or-budget' : undefined}
}

/** 全局分配有界文字预算，优先级独立于异步调用完成顺序。 */
export function projectOutputs(capture:ScriptOutputCapture,ref:string,maxChars:number,manifest?:ScriptOutputManifest,summaries:readonly ScriptOutputSummary[]=[],taskRevision=''):ScriptOutputProjection {
  const config=manifest&&Object.hasOwn(manifest.config,'maxChars')?manifest.config:capture.config
  const requestedChars=config.maxChars??ScriptOutputLimits.displayChars
  const allocatedChars=Math.max(0,Math.min(requestedChars,maxChars));const issues=capture.issues.slice(0,ScriptOutputLimits.issues)
  const ordered=capture.blocks.map((block,index)=>({block,index,view:manifest?.outputs.find(o=>o.key===block.key)?.view??block.options.view??{}})).sort((a,b)=>Number(Boolean(b.block.options.required))-Number(Boolean(a.block.options.required))||({high:0,normal:1,low:2}[a.block.options.priority??'normal']-({high:0,normal:1,low:2}[b.block.options.priority??'normal'])||(a.block.options.key&&b.block.options.key?a.block.key.localeCompare(b.block.key,'en'):a.index-b.index)))
  let blocks=ordered.map(({block,index,view})=>renderBlock(block,index,{...view,mode:'reference'},ref,0,summaries,taskRevision))
  let omittedBlocks=0
  const encode=()=>JSON.stringify({blocks,omittedBlocks,issues: !isEmpty(issues) ? issues : undefined})
  while(!isEmpty(blocks)&&encode().length>allocatedChars){blocks.pop();omittedBlocks++}
  for(let i=0;i<blocks.length;i++){
    const {block,index,view}=ordered[i]!;const remaining=Math.max(0,allocatedChars-encode().length)
    let budget=block.options.required?remaining:Math.floor(remaining/(blocks.length-i))
    const previous=blocks[i]!
    for(let attempt=0;attempt<16;attempt++){
      blocks[i]=renderBlock(block,index,view,ref,budget,summaries,taskRevision)
      if(encode().length<=allocatedChars)break
      blocks[i]=previous;budget=Math.floor(budget/2)
    }
  }
  let prompt=encode()
  if(prompt.length>allocatedChars){prompt='';blocks=[];omittedBlocks=capture.blocks.length}
  return {blocks,prompt,requestedChars,allocatedChars,omittedBlocks,issues}
}
