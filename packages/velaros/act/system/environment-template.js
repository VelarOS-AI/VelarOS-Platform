// 先读当前版本，再一次提交安装、换版本、替换或删除；下一次执行使用新环境。
import { environment } from 'velaros:system'
const { list, search, describe, apply, rollback } = environment

async function inspectEnvironment() {
  return list()
}

async function findPackage(query = 'HTML parser') {
  return search({ query, limit: 10 })
}

async function packageDetails(packageName = 'cheerio@1') {
  return describe({ package: packageName })
}

async function installPackages(install = ['cheerio@1'], remove = []) {
  const current = await list()
  return apply({ baseRevision: current.revision, install, remove })
}

async function restoreEnvironment(revision = 1) {
  const current = await list()
  return rollback({ baseRevision: current.revision, revision })
}

// 安装成功后，在下一次执行中 import * as cheerio from 'cheerio'。
// 用包自身的 README、类型声明和一个实际例子核验功能；命令会进入该执行的 PATH。
