
// 示例函数按需选用；定义函数不会执行。放入对应入口并显式调用，将需要的返回值交给 output。
import { profiles, search, read } from 'velaros:search'
// observe / execute：查看 name、default 和 limits，再选择 profile。
async function availableProfiles() { return profiles() }
// execute：新建或续查有界高级搜索；profile 可省略以使用宿主默认档位。
async function investigate(query = '定位登录状态更新路径') {
 const available=await profiles()
 const profile=available.find(item=>item.default)?.name
 return searchSummary(await search({query,profile}))
}
async function continueSearch(ref) { return searchSummary(await search({resume:ref,query:'继续检查未覆盖的分支'})) }
// 正文留在可召回的证据里；主线保留结论、缺口、覆盖范围、真实用量与续查身份，partial 不能只输出发现列表。
function searchSummary(result) {
 const {evidence,...report}=result
 return {...report,evidence:evidence.map(({id,target,ref,stamp,complete})=>({id,target,ref,stamp,complete}))}
}
// observe / execute：snapshot 读已保存报告；current 刷新已有证据目标，不调用模型。
async function report(ref) { return read({ref,mode:'snapshot',offset:0,limit:4000}) }
async function refresh(ref) { return read({ref,mode:'current',offset:0,limit:8}) }

// current 按证据条目分页；版本与部分读取标记随正文流转，失败项和未刷新的后续条目分别表达。
async function currentText(ref,offset=0,limit=8) {
 const page=await read({ref,mode:'current',offset,limit})
 if(page.mode!=='current')throw Error('unexpected mode')
 const next=offset+page.items.length
 return {ref:page.ref,offset,total:page.total,modelCalled:page.modelCalled,nextOffset:next<page.total?next:null,
  items:page.items.map(item=>item.ok?{id:item.id,target:item.target,text:item.text,stamp:item.stamp,dependencies:item.dependencies,form:item.form,mediaType:item.mediaType,complete:item.complete}:{id:item.id,gap:item.status})}
}
