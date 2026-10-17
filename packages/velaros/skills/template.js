import { guide, list, load, validate, install } from 'velaros:skills'

// 开发时按需查询规范；说明内容不会预先放进提示词。
console.log(await guide())
console.log(await list())

// 按任务需要加载已安装 Skill；按需模式不要求用户先勾选。
const needed = ['guided-review']
console.log(await Promise.all(needed.map((name) => load({ name }))))

// 新加载的 npm 包从下一次程序执行开始直接 import。
// 在工作目录用 Node 创建包后，静态校验并安装；新安装代次在下一轮进入目录。
console.log(await validate({ directory: './my-skill' }))
console.log(await install({ directory: './my-skill' }))
