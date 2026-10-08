// 新任务与独立判据一起冻结。模型运行后不得改分；评分修正另存，不覆盖原结果。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const rows = Array.from({ length: 144 }, (_, i) => ({
  id: `move-${i % 97}`,
  rev: Math.floor(i / 97),
  warehouse: ['East', '北仓', 'West'][i % 3],
  sku: ['cable', '屏幕', 'dock', 'adapter'][i % 4],
  delta: (i % 2 ? -1 : 1) * ((i % 13) + 1),
  status: i % 11 === 0 ? 'void' : 'applied',
}))
const source = rows.map(JSON.stringify)
source.splice(3, 0, '{broken', '', JSON.stringify({ ...rows[4], delta: 1.5 }))
source.push(JSON.stringify({ ...rows[0], rev: 1, delta: 9, status: 'applied' }))
const inputText = source.join('\n') + '\n'

// 评分使用宿主内存中的独立参考算法；参考实现不写进模型工作区。
function expectedInventory(text) {
  const chosen = new Map(),
    invalidLines = []
  let validRows = 0
  text.split('\n').forEach((line, index) => {
    if (!line.trim()) return
    let row
    try {
      row = JSON.parse(line)
    } catch {
      invalidLines.push(index + 1)
      return
    }
    if (
      !row ||
      Array.isArray(row) ||
      ['id', 'warehouse', 'sku'].some((key) => typeof row[key] !== 'string' || !row[key].trim()) ||
      !Number.isSafeInteger(row.rev) ||
      row.rev < 0 ||
      !Number.isSafeInteger(row.delta) ||
      !['applied', 'void'].includes(row.status)
    ) {
      invalidLines.push(index + 1)
      return
    }
    validRows++
    const previous = chosen.get(row.id)
    if (!previous || row.rev >= previous.rev) chosen.set(row.id, row)
  })
  const groups = new Map()
  for (const row of chosen.values())
    if (row.status === 'applied') {
      const key = JSON.stringify([row.warehouse, row.sku])
      groups.set(key, (groups.get(key) ?? 0) + row.delta)
    }
  const totals = [...groups].map(([key, quantity]) => {
    const [warehouse, sku] = JSON.parse(key)
    return { warehouse, sku, quantity }
  })
  totals.sort((a, b) =>
    a.warehouse < b.warehouse
      ? -1
      : a.warehouse > b.warehouse
        ? 1
        : a.sku < b.sku
          ? -1
          : a.sku > b.sku
            ? 1
            : 0
  )
  return { validRows, invalidLines, replacedRows: validRows - chosen.size, totals }
}

const imports = `import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {pathToFileURL} from 'node:url';import {join} from 'node:path';import {execFileSync} from 'node:child_process';const root=process.argv[2];const phase=Number(process.argv[3]??1);`
export const development = {
  id: 'development-files',
  prompts: [
    '读取 note.txt，对完整字符串调用 JavaScript 的 String.toUpperCase()，保存 result.txt，并实际读取核对后完成。',
  ],
  files: { 'note.txt': 'development only: café and simple text\n' },
  grade: `${imports}assert.equal(await readFile(join(root,'result.txt'),'utf8'),'DEVELOPMENT ONLY: CAFÉ AND SIMPLE TEXT\\n');`,
}

export const cases = [
  {
    id: 'revision-inventory',
    prompts: [
      '完成库存修订核对工具。实现 reconcile.mjs，导出纯函数 reconcile(text)，输入 JSONL 字符串；还可通过 node reconcile.mjs input.jsonl report.json 生成报告。空白行忽略，JSON 无效或字段不合法的行收集为从 1 开始的 invalidLines。合法记录的 id、warehouse、sku 是非空白字符串，rev 是非负安全整数，delta 是有符号安全整数，status 为 applied 或 void。按 id 选择最大 rev，同 rev 取文件中较后的合法记录。仅对选中且 applied 的记录按 warehouse、sku 汇总 delta，排序按 JS 字符串比较先 warehouse 后 sku。报告是 {validRows,invalidLines,replacedRows,totals:[{warehouse,sku,quantity}]}，replacedRows=合法行数减选中的 id 数；quantity 为 0 的组仍保留。处理 movements.jsonl 生成 report.json，保持输入原文。补充 README.md 说明 CLI、修订/作废、平局和错误行规则；提供可执行 demo.mjs，分别演示修订平局与错误行两个不同例子；新增并实际运行边界回归。',
    ],
    files: {
      'movements.jsonl': inputText,
      'reconcile.mjs': 'export function reconcile(text) { throw new Error("not implemented") }\n',
    },
    preserve: ['movements.jsonl'],
    grade: `${imports}
const {reconcile:f}=await import(pathToFileURL(join(root,'reconcile.mjs')));
const original=await readFile(join(root,'movements.jsonl'),'utf8');
assert.deepEqual(f(original),${JSON.stringify(expectedInventory(inputText))});
assert.deepEqual(JSON.parse(await readFile(join(root,'report.json'),'utf8')),${JSON.stringify(expectedInventory(inputText))});
const base={id:'x',warehouse:'A',sku:'K',rev:2,delta:3,status:'applied'};
const trial=[base,{...base,rev:1,delta:99},{...base,delta:-3},{...base,id:'y',delta:3},{...base,id:'z',status:'void'},null,{...base,id:'w',rev:-1},[base],{...base,id:'q',warehouse:' '}].map(JSON.stringify).join('\\n');
assert.deepEqual(f(trial),{validRows:5,invalidLines:[6,7,8,9],replacedRows:2,totals:[{warehouse:'A',sku:'K',quantity:0}]});
assert.deepEqual(f(' \\n\\n'),{validRows:0,invalidLines:[],replacedRows:0,totals:[]});
execFileSync(process.execPath,['reconcile.mjs','movements.jsonl','rerun-report.json'],{cwd:root,timeout:10000});
assert.deepEqual(JSON.parse(await readFile(join(root,'rerun-report.json'),'utf8')),f(original));
execFileSync(process.execPath,['demo.mjs'],{cwd:root,timeout:10000});
const guide=await readFile(join(root,'README.md'),'utf8');assert(guide.length>160);assert(/reconcile.mjs/.test(guide));
const demo=await readFile(join(root,'demo.mjs'),'utf8');assert(demo.trim().length>0);
`,
    control: {
      'reconcile.mjs': `import {readFile,writeFile} from 'node:fs/promises';import {pathToFileURL} from 'node:url';export const reconcile=${expectedInventory.toString()};if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){await writeFile(process.argv[3],JSON.stringify(reconcile(await readFile(process.argv[2],'utf8'))))}`,
      'README.md':
        'Run node reconcile.mjs movements.jsonl report.json. The highest revision wins; later lines break ties. A void revision cancels its previous applied change. Invalid lines are recorded with one-based indexes. Empty lines are ignored. demo.mjs demonstrates tie handling and invalid rows.',
      'demo.mjs': `import {reconcile} from './reconcile.mjs';const row={id:'x',warehouse:'A',sku:'K',rev:1,delta:2,status:'applied'};console.log(reconcile([row,{...row,delta:5}].map(JSON.stringify).join('\\n')));console.log(reconcile('{broken'));`,
      'report.json': JSON.stringify(expectedInventory(inputText)),
    },
  },
  {
    id: 'dependency-waves-revision',
    prompts: [
      '实现 plan.mjs，导出 planWaves(nodes)，把依赖任务排成可并行执行的波次数组。nodes 为 {id,dependsOn} 数组；id 与依赖 id 均为非空白字符串，dependsOn 为数组，重复依赖按一条处理。每一波取当时所有已满足依赖的节点，按 JS 字符串比较升序，返回 string[][]；不能修改输入及嵌套数组。空输入返回 []。错误必须带 code：形状错误 INVALID_INPUT、重复节点 DUPLICATE_NODE、不存在的依赖 UNKNOWN_DEPENDENCY、环 CYCLE。先完整检查输入形状，再检查重复节点、未知依赖和环。补充 README.md，完整说明 API、排序、边界和全部错误码；demo.mjs 必须实际演示一个多波次图和一个捕获 CYCLE 的例子；新增并运行回归测试。',
      '增加一个向后兼容的可选参数 planWaves(nodes, {ignoreMissing:true})：这个选项把不存在的依赖视为已由外部完成。默认和 {ignoreMissing:false} 仍按 UNKNOWN_DEPENDENCY 报错，已存在节点的环仍报 CYCLE，输入保持不变。更新 README.md 和 demo.mjs；两个原示例都保留，再增加一个外部依赖的示例。按当前最终实现重新跑回归。',
    ],
    files: { 'plan.mjs': 'export function planWaves(nodes) { return [] }\n' },
    grade: `${imports}
const {planWaves:f}=await import(pathToFileURL(join(root,'plan.mjs')));
const input=Object.freeze([{id:'publish',dependsOn:Object.freeze(['test','build','build'])},{id:'test',dependsOn:Object.freeze(['build'])},{id:'build',dependsOn:Object.freeze([])},{id:'audit',dependsOn:Object.freeze([])}].map(Object.freeze));
assert.deepEqual(f(input),[['audit','build'],['test'],['publish']]);assert.deepEqual(f([]),[]);
const throws=(value,code,options)=>assert.throws(()=>f(value,options),error=>error?.code===code);
throws(null,'INVALID_INPUT');throws([{id:'a',dependsOn:[]} , {id:'a',dependsOn:null}],'INVALID_INPUT');throws([{id:'a',dependsOn:[]},{id:'a',dependsOn:[]}],'DUPLICATE_NODE');throws([{id:'x',dependsOn:['missing']}],'UNKNOWN_DEPENDENCY');throws([{id:'a',dependsOn:['b']},{id:'b',dependsOn:['a']}],'CYCLE');throws([{id:'a',dependsOn:['a']}],'CYCLE');
for(let n=1;n<=31;n++){const chain=Array.from({length:n},(_,i)=>({id:'node-'+i,dependsOn:i?['node-'+(i-1)]:[]})).reverse();const saved=JSON.stringify(chain);assert.deepEqual(f(chain),Array.from({length:n},(_,i)=>['node-'+i]));assert.equal(JSON.stringify(chain),saved)}
if(phase===2){assert.deepEqual(f([{id:'b',dependsOn:['a','external']},{id:'a',dependsOn:['outside']}],{ignoreMissing:true}),[['a'],['b']]);throws([{id:'a',dependsOn:['external']}],'UNKNOWN_DEPENDENCY',{ignoreMissing:false});throws([{id:'a',dependsOn:['a','external']}],'CYCLE',{ignoreMissing:true})}
execFileSync(process.execPath,['demo.mjs'],{cwd:root,timeout:10000});
const guide=await readFile(join(root,'README.md'),'utf8');for(const code of ['INVALID_INPUT','DUPLICATE_NODE','UNKNOWN_DEPENDENCY','CYCLE'])assert(guide.includes(code));if(phase===2)assert(guide.includes('ignoreMissing'));
const demo=await readFile(join(root,'demo.mjs'),'utf8');assert(demo.trim().length>0);
`,
    control: {
      'plan.mjs': `export function planWaves(nodes,options={}) { const fail=code=>{throw Object.assign(Error(code),{code})};if(!Array.isArray(nodes)||nodes.some(x=>!x||typeof x.id!=='string'||!x.id.trim()||!Array.isArray(x.dependsOn)||x.dependsOn.some(y=>typeof y!=='string'||!y.trim())))fail('INVALID_INPUT');const ids=new Set(nodes.map(x=>x.id));if(ids.size!==nodes.length)fail('DUPLICATE_NODE');if(!options.ignoreMissing&&nodes.some(x=>x.dependsOn.some(y=>!ids.has(y))))fail('UNKNOWN_DEPENDENCY');const remaining=new Map(nodes.map(x=>[x.id,new Set(x.dependsOn.filter(y=>ids.has(y)))]));const done=new Set(),out=[];while(remaining.size){const wave=[...remaining].filter(([,deps])=>[...deps].every(x=>done.has(x))).map(([id])=>id).sort();if(!wave.length)fail('CYCLE');out.push(wave);for(const id of wave){done.add(id);remaining.delete(id)}}return out}`,
      'README.md':
        'planWaves(nodes, {ignoreMissing:true}) plans sorted waves. INVALID_INPUT precedes DUPLICATE_NODE, UNKNOWN_DEPENDENCY and CYCLE. Missing dependencies are errors by default and may be treated as externally completed when ignoreMissing is true. Repeated edges collapse, empty input yields [], all input arrays remain unchanged.',
      'demo.mjs': `import {planWaves} from './plan.mjs';console.log(planWaves([{id:'a',dependsOn:[]},{id:'b',dependsOn:['a']}]));try{planWaves([{id:'a',dependsOn:['a']}])}catch(e){if(e.code!=='CYCLE')throw e;console.log(e.code)}console.log(planWaves([{id:'a',dependsOn:['external']}],{ignoreMissing:true}));`,
    },
  },
]
assert(cases.every((item) => item.prompts.length && item.grade && item.control))
export const suiteHash = createHash('sha256').update(JSON.stringify(cases)).digest('hex')
