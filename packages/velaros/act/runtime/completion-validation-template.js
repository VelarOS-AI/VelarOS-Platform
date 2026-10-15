import { execute } from 'velaros:completion-validation'

async function validate(requirementIds, artifacts, code) {
  return execute({ requirementIds, artifacts, code })
}
// code 为 Node.js ESM；JSON.parse(process.env.VELAR_REVIEW_INPUTS) 将所选文件身份映射为只读 URL。
// 在临时工作目录执行，不能启动子进程或联网。一次断言通过不代表其他需求已经验证。
