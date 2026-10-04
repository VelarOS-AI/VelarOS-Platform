import {output} from 'velaros'
import {list,read,submit} from 'velaros:context-materials'
// runtime.modelTool.recent 给出原文与精确引用；先按需要补读，可在同次执行中批量读取。
async function inspectKnown(ref,offset=0){ output(await read({ref,offset,limit:12000})) }
async function discoverEarlier(){
 const page=await list({limit:16})
 output(page)
 if(page.items.length)output(await read({ref:page.items[0].ref,limit:12000}))
}
// 基于实际读到的原文交补丁；原生调用成功后由宿主交付，文本协议继续声明完成。
async function deliver(baseRevision){
 output(await submit({baseRevision,summary:'有证据支持的整理说明',unresolved:[]}))
}
