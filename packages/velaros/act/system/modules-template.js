
// 示例函数按需选用；定义函数不会执行。放入对应入口并显式调用，将需要的返回值交给 output。
import { modules } from 'velaros:system'
const { list, search, describe } = modules
// observe / execute：只看当前授权模块。分页沿 nextOffset 继续。
async function discover() { return list({offset:0,limit:20}) }
async function find() { return search({query:'files',limit:10}) }
// 返回准确 schema、声明和本模块的 template；按需要选择正文输出。
async function usage() { const api = await describe({module:'velaros:system',export:'memory'}); return api.template }
async function types() { const api = await describe({module:'velaros:system',export:'memory'}); return api.declarations }
