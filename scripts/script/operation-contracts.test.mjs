import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { Ajv } from '../../packages/kernel/node_modules/ajv/dist/ajv.js'
import { operationSchema } from './operation-contracts.mjs'
function schemas(text){
  const root=mkdtempSync(join(tmpdir(),'operation-contract-')),file=join(root,'types.ts')
  try{
    writeFileSync(file,text)
    const program=ts.createProgram([file],{strict:true,target:ts.ScriptTarget.ES2022}),checker=program.getTypeChecker()
    return Object.fromEntries(program.getSourceFile(file).statements.filter(ts.isTypeAliasDeclaration).map(node=>[node.name.text,operationSchema(checker,checker.getTypeAtLocation(node))]))
  }finally{rmSync(root,{recursive:true,force:true})}
}
test('recursive unions, optional tuples and dictionary fields retain strict JSON contracts',()=>{
  const defs=schemas(`type Tree={kind:'branch';children:Tree[]}|{kind:'leaf';value:string};type Pair=[string,number?];type Settings={flags:Record<string,boolean>;optional?:string};type Nothing=never;`)
  const ajv=new Ajv({strict:true}),tree=ajv.compile(defs.Tree),pair=ajv.compile(defs.Pair),settings=ajv.compile(defs.Settings)
  assert(tree({kind:'branch',children:[{kind:'leaf',value:'ok'}]}));assert(!tree({kind:'leaf',value:12}));assert(!tree({kind:'leaf',value:'ok',extra:true}))
  assert(pair(['one']));assert(pair(['one',2]));assert(!pair(['one','bad']));assert(!pair(['one',2,3]));assert(!pair([]))
  assert(settings({flags:{ready:true}}));assert(!settings({flags:{ready:'yes'}}));assert(!ajv.compile(defs.Nothing)(null))
})
test('unsupported non-JSON contracts fail generation',()=>{
  for(const definition of ['bigint','symbol','()=>void','[string,...number[]]'])assert.throws(()=>schemas(`type Bad=${definition};`))
})
