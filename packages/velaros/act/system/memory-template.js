// execute 中维护工作笔记；list/read 可用于只读观察。
import {output} from 'velaros';
import {memory} from 'velaros:system';
const {list,read,update,plan,retain,release,organize}=memory;
async function example(){
 const notes=await list({kind:'notes',limit:8});
 const previous=notes.items.find(item=>item.key==='progress');
 const note=await update({key:'progress',baseRevision:previous?.revision??0,body:'接下来验证当前修改',sources:[]});
 if(!note.ref)throw new Error('笔记更新没有返回引用');
 output(await read({ref:note.ref,limit:2000}));
 await plan({nextObjective:'验证当前修改',openQuestions:['边界情况是否覆盖']}); // 计划只给要改的字段
 await retain({ref:note.ref});
 await release({ref:note.ref});
 output(await organize({focus:'接下来验证当前修改，保留用户约束'})); // scheduled；实际结果见下一帧 memoryStatus.maintenance
}
// ref 和 pointer 取自执行结果展示；offset 按选中字段的字符算。
async function readResultField(ref,pointer,offset=0){
 const page=await read({ref,pointer,offset,limit:4000});
 output({ref:page.record.ref,pointer:page.pointer,offset:page.offset,totalChars:page.totalChars},{key:'range'});
 output(page.text,{key:'source',type:'code'});
}

// 核销 required 用 runtime.decision.missing[].read 的整块入口。完整页对象保留宿主交付回执。
// 可在一段 execute 中逐页 output；展示额度有限，页正文没完整进入模型时仍保留缺口。
// keyPrefix 由调用方为每个原块提供唯一前缀，允许同次执行读取多个原块。
async function readRequiredPage(input,keyPrefix,offset=0){
 const page=await read({...input,offset,limit:2000});
 output(page,{key:keyPrefix+'_'+offset,view:{mode:'full'}});
 return page.offset+page.text.length<page.totalChars?page.offset+page.text.length:null;
}

// 失败后的调用原文仍在日志：按失败帧 recovery.index 读索引，再按 id 读取原回执；没有重跑。
// keyPrefix 使用合法的 output.key 前缀；invocation 含冒号，不能直接当输出 key。
async function readFailedCallPage(ref,invocation,keyPrefix,offset=0){
 const page=await read({ref,invocation,offset,limit:2000});
 output(page,{key:keyPrefix+'_'+offset,view:{mode:'full'}});
 return page.offset+page.text.length<page.totalChars?page.offset+page.text.length:null;
}
