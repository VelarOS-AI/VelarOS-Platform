// execute 中维护工作笔记；list/read 可用于只读观察。
import {output} from 'velaros';
import {memory} from 'velaros:system';
const {list,read,update,retain,release}=memory;
async function example(){
 const notes=await list({kind:'notes',limit:8});
 const previous=notes.items.find(item=>item.key==='progress');
 const note=await update({key:'progress',baseRevision:previous?.revision??0,body:'接下来验证当前修改',sources:[]});
 if(!note.ref)throw new Error('笔记更新没有返回引用');
 output(await read({ref:note.ref,limit:2000}));
 await retain({ref:note.ref});
 await release({ref:note.ref});
}
