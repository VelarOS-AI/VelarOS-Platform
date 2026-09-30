// execute 中维护工作笔记；list/read 可用于只读观察。
import {output} from 'velaros';
import {memory} from 'velaros:system';
const {list,read,update,plan,retain,release}=memory;
async function example(){
 const notes=await list({kind:'notes',limit:8});
 const previous=notes.items.find(item=>item.key==='progress');
 const note=await update({key:'progress',baseRevision:previous?.revision??0,body:'接下来验证当前修改',sources:[]});
 if(!note.ref)throw new Error('笔记更新没有返回引用');
 output(await read({ref:note.ref,limit:2000}));
 await plan({nextObjective:'验证当前修改',openQuestions:['边界情况是否覆盖']}); // 计划只给要改的字段
 await retain({ref:note.ref});
 await release({ref:note.ref});
}
// ref 和 pointer 取自执行结果展示；offset 按选中字段的字符算。
async function readResultField(ref,pointer,offset=0){
 const page=await read({ref,pointer,offset,limit:4000});
 output({ref:page.record.ref,pointer:page.pointer,offset:page.offset,totalChars:page.totalChars},{key:'range'});
 output(page.text,{key:'source',type:'code'});
}
