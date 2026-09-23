import {output} from 'velaros'
import {list,read,submit} from 'velaros:context-materials'
async function inspect(){
 const page=await list({limit:16})
 output(page)
 if(page.items.length)output(await read({ref:page.items[0].ref,limit:12000}))
}
// 基于实际读到的原文交补丁：最小补丁只有这三个字段，其余只在确实需要且已查明时加；受理之后再声明完成
async function deliver(baseRevision){
 output(await submit({baseRevision,summary:'有证据支持的整理说明',unresolved:[]}))
}
