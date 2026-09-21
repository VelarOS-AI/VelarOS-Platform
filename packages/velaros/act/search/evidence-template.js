
// 示例函数按需选用；定义函数不会执行。放入对应入口并显式调用，将需要的返回值交给 output。
import { query, read } from 'velaros:evidence'
// 仅搜索作用域、仅 execute；source 使用本轮实际授权来源。query 是字面匹配，使用短关键词。
async function candidates(source) {
 const page=await query({source,query:'session',limit:16})
 return page.candidates
}
// target 使用候选中的真实 target；返回版本、证据 ID 和原文引用。
async function inspect(target) {
 const evidence=await read({target,maxBytes:8000})
 return {id:evidence.id,ref:evidence.ref,text:evidence.excerpt,revision:evidence.stamp.revision,complete:evidence.complete}
}
