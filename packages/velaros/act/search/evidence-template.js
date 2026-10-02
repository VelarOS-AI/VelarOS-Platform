
// 示例函数按需选用；定义函数不会执行。放入对应入口并显式调用，将需要的返回值交给 output。
import { query, read, report } from 'velaros:evidence'
// 仅搜索作用域、仅 execute；source 使用本轮实际授权来源。query 是字面匹配，使用短关键词。
async function candidates(source) {
 const page=await query({source,query:'session',limit:16})
 return page.candidates
}
// target 使用候选中的真实 target；返回版本、证据 ID 和原文引用。
async function inspect(target) {
 const evidence=await read({target,maxBytes:8000})
 return {id:evidence.id,target:evidence.target,ref:evidence.ref,text:evidence.excerpt,stamp:evidence.stamp,complete:evidence.complete}
}
// 有界地读本次选中的候选；候选 preview 只用于选择，证据仍来自 read，不把未读项或部分正文称为全覆盖。
async function collect(source,keyword='session',readLimit=4) {
 const page=await query({source,query:keyword,limit:16})
 const selected=page.candidates.slice(0,readLimit)
 const evidence=[]
 const gaps=[]
 for(const candidate of selected) {
  try { evidence.push(await inspect(candidate.target)) }
  catch(error) { gaps.push({candidateId:candidate.id,target:candidate.target,code:error.code,message:error.message}) }
 }
 return {source:page.source,query:page.query,empty:page.empty,candidateLimit:16,evidence,gaps,
  unread:page.candidates.slice(selected.length).map(({id,target})=>({id,target}))}
}
// 交付结论：每条发现引用 read 登记的证据 id，没查清的写进 gaps；受理之后再声明完成。
async function deliver(evidenceId) {
 return report({findings:[{text:'会话恢复时更新登录状态',evidenceIds:[evidenceId]}],gaps:[{code:'UNRESOLVED',detail:'尚未确认过期处理'}],nextSteps:[]})
}
