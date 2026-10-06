import { guide, list, load, validate, install } from 'velaros:skills'

// 开发时按需查询规范；说明内容不会预先放进提示词。
console.log(await guide())
console.log(await list())

// 按名称加载已经在本轮环境中的 Skill。
console.log(await load({ name: 'guided-review' }))

// 在工作目录用 Node 创建包后，静态校验并安装；安装后在会话中选择使用。
console.log(await validate({ directory: './my-skill' }))
console.log(await install({ directory: './my-skill' }))
