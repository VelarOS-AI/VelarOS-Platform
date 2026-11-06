import { list, load } from 'velaros:features'
console.log(await list())
// 只加载当前任务需要的能力，使用实际目录返回的稳定身份。
console.log(await load({ id: 'visualization' }))
