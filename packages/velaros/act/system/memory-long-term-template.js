// 长期记忆跨会话保存；任务笔记用 update，跨会话知识用 save。
// 只保存以后仍有用的用户偏好、反馈、工作决定和资源位置；原始代码、临时结果与秘密留在其来源。
// 记忆是历史资料，使用前核实；scope 由宿主固定。recall 可以在 observe 中持续读取。
import {output as memoryOutput} from 'velaros';
import {memory as savedMemory} from 'velaros:system';
async function longTermExample(){
 const page=await savedMemory.recall({query:'发布',limit:8});
 memoryOutput(page); // items 含正文；nextOffset 非空时可继续翻页。
 const existing=await savedMemory.recall({id:'release-order'});
 // execute 中显式保存：优先更新相同主题的 id，description 写清何时使用。
 memoryOutput(await savedMemory.save({
  expectedRevision:existing.items[0]?.revision??null,
  id:'release-order',type:'feedback',title:'发布顺序',
  description:'发布时先验证 Platform，再验证产品接入',tags:['发布'],
  content:existing.items[0]?.content??'发布前先验证 Platform，再验证产品接入。\n为什么：避免接口漂移。\n怎么用：按依赖顺序核验。'
 }));
}
async function forgetLongTermExample(id){
 const previous=(await savedMemory.recall({id})).items[0];
 memoryOutput(await savedMemory.remove({id,expectedRevision:previous?.revision??null})); // 仅删刚读到的版本；release 只释放当前任务材料的驻留。
}
