
// 示例函数按需选用；定义函数不会执行。放入对应入口并显式调用，将需要的返回值交给 output。
import { profiles, search, read } from 'velaros:search'
// observe / execute：查看 name、default 和 limits，再选择 profile。
async function availableProfiles() { return profiles() }
// execute：新建或续查有界高级搜索；profile 可省略以使用宿主默认档位。
async function investigate() {
 const available=await profiles()
 const profile=available.find(item=>item.default)?.name
 return search({query:'定位登录状态更新路径',profile})
}
async function continueSearch(ref) { return search({resume:ref,query:'继续检查未覆盖的分支'}) }
// observe / execute：snapshot 读已保存报告；current 刷新已有证据目标，不调用模型。
async function report(ref) { return read({ref,mode:'snapshot',offset:0,limit:4000}) }
async function refresh(ref) { return read({ref,mode:'current',offset:0,limit:8}) }

// snapshot 返回 text/offset/totalChars；current 的每个 item 用 ok 判断是否有正文。
async function currentText(ref) {
 const page=await read({ref,mode:'current',offset:0,limit:8})
 if(page.mode!=='current')throw Error('unexpected mode')
 return page.items.map(item=>item.ok?{id:item.id,text:item.text,complete:item.complete}:{id:item.id,gap:item.status})
}
