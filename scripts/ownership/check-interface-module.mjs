// 检查 interface/contract 结构；旧单元继续使用既有的全部检查。
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, basename, dirname, resolve } from 'node:path'
import ts from 'typescript'

export function checkInterfaceModule(root, module, fail) {
  const dir=join(root,'packages',module.directory)
  const src=join(dir,'src')
  const label=module.name
  const allowed=new Set(['interface','contract','impl','utils'])
  const parse=file=>ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true)
  const files=folder=>readdirSync(folder,{withFileTypes:true}).flatMap(e=>e.isDirectory()?[...(fail(`${label}: ${folder}/${e.name} 必须保持扁平`),[])]:e.name.endsWith('.ts')?[join(folder,e.name)]:[])
  for(const e of readdirSync(src,{withFileTypes:true})) if(e.isDirectory()&&!allowed.has(e.name)) fail(`${label}: 未登记目录 ${e.name}`)
  const interfaces=new Map()
  const iface=join(src,'interface')
  for(const name of ['provides.ts','requires.ts','internal.ts']) if(!existsSync(join(iface,name))) fail(`${label}: 缺少 ${name}`)
  for(const file of files(iface)) {
    if(!['provides.ts','requires.ts','internal.ts'].includes(basename(file))) fail(`${label}: interface 只允许三个合同文件`)
    for(const n of parse(file).statements) {
      if(ts.isImportDeclaration(n)&&n.importClause?.isTypeOnly) continue
      if(ts.isExportDeclaration(n)&&!n.moduleSpecifier) continue
      if(!ts.isInterfaceDeclaration(n)&&!ts.isTypeAliasDeclaration(n)) {fail(`${label}: 接口目录出现运行时代码`);continue}
      if(!n.jsDoc?.length) fail(`${label}: 接口 ${n.name.text} 缺少说明`)
      if(ts.isInterfaceDeclaration(n)) {
        interfaces.set(n.name.text,new Set(n.members.map(m=>m.name?.getText())))
        for(const m of n.members) if(!m.jsDoc?.length) fail(`${label}: ${n.name.text}.${m.name?.getText()} 缺少说明`)
      }
    }
  }
  for(const file of files(join(src,'contract'))) {
    const visit=n=>{
      if(ts.isImportDeclaration(n)||ts.isMethodSignature(n)||ts.isFunctionTypeNode(n)||ts.isFunctionDeclaration(n)||ts.isArrowFunction(n)||ts.isClassDeclaration(n)) fail(`${label}: 可移植数据 ${basename(file)} 包含导入或行为`)
      ts.forEachChild(n,visit)
    }
    visit(parse(file))
  }
  for(const file of files(join(src,'impl'))) {
    const classes=parse(file).statements.filter(ts.isClassDeclaration)
    if(classes.length!==1||classes[0].name?.text!==basename(file,'.ts')) fail(`${label}: ${basename(file)} 需要一个同名实现类`)
    for(const c of classes) {
      const contract=c.heritageClauses?.find(h=>h.token===ts.SyntaxKind.ImplementsKeyword)?.types[0]?.expression.getText()
      const members=interfaces.get(contract)
      if(!members) fail(`${label}: ${c.name?.text} 必须实现 interface 中的接口`)
      for(const m of c.members) {
        if(ts.isConstructorDeclaration(m)||m.modifiers?.some(x=>x.kind===ts.SyntaxKind.PrivateKeyword||x.kind===ts.SyntaxKind.ProtectedKeyword)) continue
        if(!members?.has(m.name?.getText())) fail(`${label}: ${c.name?.text}.${m.name?.getText()} 不在接口中`)
      }
    }
  }
  for(const file of files(join(src,'utils'))) for(const n of parse(file).statements) {
    if(ts.isClassDeclaration(n)||ts.isInterfaceDeclaration(n)||ts.isTypeAliasDeclaration(n)) fail(`${label}: utils 中出现类或类型`)
    if(ts.isVariableStatement(n)&&!(n.declarationList.flags&ts.NodeFlags.Const)) fail(`${label}: utils 出现可变全局状态`)
  }
  const manifest=JSON.parse(readFileSync(join(dir,'package.json'),'utf8'))
  const visited=new Set()
  const browser=file=>{
    if(visited.has(file))return
    visited.add(file)
    for(const n of parse(file).statements) if((ts.isImportDeclaration(n)||ts.isExportDeclaration(n))&&n.moduleSpecifier&&!n.isTypeOnly&&!n.importClause?.isTypeOnly) {
      const spec=n.moduleSpecifier.text
      if(spec.startsWith('node:'))fail(`${label}: 浏览器入口传递引用 ${spec}`)
      if(spec.startsWith('.')) {const target=resolve(dirname(file),spec.replace(/\.js$/u,'.ts'));if(existsSync(target))browser(target)}
    }
  }
  for(const entry of module.browserSafeEntries) browser(join(src,entry))
  for(const [name, target] of Object.entries(manifest.exports)) {
    if(module.entryPrefix && !target.import?.startsWith(`./dist/${module.entryPrefix}`)) continue
    const file=join(src,name==='.'?'index.ts':name.slice(2)+'.ts')
    if(!existsSync(file)){fail(`${label}: 缺少入口 ${name}`);continue}
    for(const n of parse(file).statements) if(!ts.isExportDeclaration(n)) fail(`${label}: 入口必须只转发 ${name}`)
  }
  for(const name of [module.card,module.invariants,module.acceptance]) if(!existsSync(join(dir,name)))fail(`${label}: 缺少 ${name}`)
  if(!manifest.scripts?.test?.includes(module.acceptance))fail(`${label}: test 脚本没有执行验收`)
  console.info(`✓ ${label}: interface/contract 结构、接口实现、入口与浏览器边界已检查`)
}
