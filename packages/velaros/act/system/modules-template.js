
// 示例函数按需选用；定义函数不会执行。放入对应入口并显式调用，将需要的返回值交给 output。
import { modules } from 'velaros:system'
const { list, search, describe } = modules
// observe / execute：只看当前授权模块。分页沿 nextOffset 继续。
async function discover() { return list({offset:0,limit:20}) }
async function find() { return search({query:'files',limit:10}) }
// 查询多个真实导出一次返回去重的类型闭包；模板只在需要组合示例时请求。
async function projectContracts() { const api = await describe({module:'velaros:project',exports:['read','edit']}); return api.declarations }
async function usage() { const api = await describe({module:'velaros:system',exports: ['memory'],template:true}); return api.template }
async function types() { const api = await describe({module:'velaros:system',exports: ['memory']}); return api.declarations }
