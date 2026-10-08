// 任务与独立验收在首次模型调用前按 SHA-256 冻结；执行器不按成绩修改任务。
import { createHash } from 'node:crypto'

const literal =
  '# Release @@VERSION@@\n\n```js\nconst raw = `literal ${value}`;\nconst regex = /\\w+\\s*\\$[0-9]+/gu;\nconst path = "C:\\temp\\new\\file.txt";\n```\n\n中文 👩🏽‍💻 “quote” \'apostrophe\'\n<tag attr="a & b">${notEvaluated}</tag>\nTabs:\tA\tB\nEmpty line follows:\n\nLast line.\n'
const events = Array.from({ length: 144 }, (_, i) => ({
  id: `entry-${i % 117}`,
  currency: ['USD', 'EUR', 'JPY'][i % 3],
  cents: (i % 2 ? -1 : 1) * (17 * i + 29),
  account: `account-${i % 7}`,
  at: new Date(Date.UTC(2026, 8, 28, 19 + i, i % 60)).toISOString(),
}))
const totals = new Map()
for (const item of events.slice(0, 117)) {
  const key = item.at.slice(0, 10) + '/' + item.currency
  totals.set(key, (totals.get(key) ?? 0) + item.cents)
}
const ledgerExpected = {
  unique: 117,
  duplicates: 27,
  totals: [...totals]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, cents]) => ({ key, cents })),
}
const imports = `import assert from 'node:assert/strict'; import {readFile,writeFile} from 'node:fs/promises'; import {pathToFileURL} from 'node:url'; import {join} from 'node:path'; const root=process.argv[2];`
export const development = {
  id: 'development-smoke',
  prompt: '读取 input.txt，将内容按字符反转写入 output.txt，并实际读取验证，然后答复。',
  files: { 'input.txt': 'small development example' },
  grade: String.raw`${imports} assert.equal(await readFile(join(root,'output.txt'),'utf8'),'elpmaxe tnempoleved llams');`,
}
export const cases = [
  {
    id: 'version-selection',
    prompt:
      '修复 versions.mjs 的 selectVersion(versions, major)，只接受严格的三段非负整数版本（各段不能有多余前导零）；去除重复，按数值选择给定 major 的最大版本，没有匹配返回 null。不要修改输入数组。保留公开导出。补充并实际运行回归验证。',
    files: {
      'versions.mjs':
        "export function selectVersion(versions, major) { return versions.filter(v=>v.startsWith(major+'.')).sort().at(-1) ?? null }\n",
    },
    grade: String.raw`${imports} const {selectVersion:f}=await import(pathToFileURL(join(root,'versions.mjs'))); const input=Object.freeze(['2.9.9','2.10.0','2.010.5','2.12','2.12.0-beta','2.10.0','20.99.1','2.9.12']); assert.equal(f(input,2),'2.10.0'); assert.equal(f(input,20),'20.99.1'); assert.equal(f(input,3),null); assert.equal(f(['0.0.0','0.0.12','0.0.9'],0),'0.0.12'); assert.equal(f(['1.2.3x','1.-1.2','1.2.03','v1.2.4'],1),null);`,
  },
  {
    id: 'configuration-migration',
    prompt:
      '完善 migrate.mjs 的 migrate(config)，用于迁移旧项目配置：原对象及其嵌套对象都不能被修改；返回 schemaVersion:2；旧 timeoutSeconds 若为有限非负数，转为 network.timeoutMs（四舍五入毫秒），若 network 已有有限非负 timeoutMs 则优先保留它；均无有效值时默认 5000。删除旧 timeoutSeconds，保留其他所有字段。函数应幂等，连续调用结果相同。实际运行不同输入的测试。',
    files: {
      'migrate.mjs':
        'export function migrate(config) { const result={...config}; result.network ??= {}; result.network.timeoutMs=config.timeoutSeconds*1000; result.schemaVersion=2; return result; }\n',
    },
    grade: String.raw`${imports} const {migrate:f}=await import(pathToFileURL(join(root,'migrate.mjs'))); const input={timeoutSeconds:1.2346,network:{retry:3},custom:{nested:[1,2]}}; const before=structuredClone(input); const out=f(input); assert.deepEqual(input,before); assert.deepEqual(out,{schemaVersion:2,network:{retry:3,timeoutMs:1235},custom:{nested:[1,2]}}); out.custom.nested.push(3); assert.deepEqual(input,before); assert.deepEqual(f(f(input)),f(input)); assert.equal(f({timeoutSeconds:9,network:{timeoutMs:0}}).network.timeoutMs,0); for(const timeoutSeconds of [-1,NaN,Infinity,'3',null,undefined]) assert.equal(f({timeoutSeconds}).network.timeoutMs,5000); assert.equal(f({network:{timeoutMs:NaN},timeoutSeconds:2}).network.timeoutMs,2000);`,
  },
  {
    id: 'ledger-reconciliation',
    prompt:
      '核对 events.jsonl 并写出 report.json：以 id 去重，重复时保留文件中首次出现的记录。按 UTC 日期和 currency 汇总 cents（整数，允许负值），key 使用 YYYY-MM-DD/CURRENCY 并按 key 升序。格式为 {unique,duplicates,totals:[{key,cents}]}。保存可重跑脚本 reconcile.mjs，执行并验证结果；保持原始文件不变。',
    files: { 'events.jsonl': events.map((event) => JSON.stringify(event)).join('\n') + '\n' },
    grade: String.raw`${imports} assert.deepEqual(JSON.parse(await readFile(join(root,'report.json'),'utf8')),${JSON.stringify(ledgerExpected)}); assert.match(await readFile(join(root,'reconcile.mjs'),'utf8'),/./);`,
    preserve: ['events.jsonl'],
    rerun: ['reconcile.mjs'],
  },
  {
    id: 'literal-template',
    prompt: `创建 release-template.md，内容必须逐字等于下面两个界定行之间的原文（包含末尾换行，不包含界定行）。再创建 render.mjs：读取模板，仅将所有 @@VERSION@@ 替换为第一个命令行参数的字面值，写入 release.md。运行 node render.mjs 1.7.0 并验证。\nBEGIN_EXACT_TEMPLATE\n${literal}END_EXACT_TEMPLATE`,
    files: {},
    grade: String.raw`${imports} assert.equal(await readFile(join(root,'release-template.md'),'utf8'),${JSON.stringify(literal)}); const {execFileSync}=await import('node:child_process'); const version='2.0-$&-中文'; execFileSync(process.execPath,['render.mjs',version],{cwd:root}); assert.equal(await readFile(join(root,'release.md'),'utf8'),${JSON.stringify(literal)}.split('@@VERSION@@').join(version));`,
  },
  {
    id: 'continuous-observation',
    prompt:
      '完成 state.json 的分阶段配置更新。先注册持续只读 observe，输出 phase、limits 和 items.length，每次更新后读取下一轮观察再继续。第一阶段将 phase 改为 1，limits.maxItems 改为 3，并保留其他字段；观察确认后再把 items 去重且截取前 3 个，phase 改为 2。将每次阶段完成的 phase 按顺序追加到 phases.jsonl。最终确认状态后答复。',
    files: {
      'state.json': JSON.stringify({
        phase: 0,
        limits: { maxItems: -1, maxBytes: 2048 },
        items: ['a', 'b', 'a', 'c', 'd'],
        memo: 'keep',
      }),
    },
    grade: String.raw`${imports} assert.deepEqual(JSON.parse(await readFile(join(root,'state.json'),'utf8')),{phase:2,limits:{maxItems:3,maxBytes:2048},items:['a','b','c'],memo:'keep'}); assert.deepEqual((await readFile(join(root,'phases.jsonl'),'utf8')).trim().split('\n').map(JSON.parse),[1,2]);`,
    requireObservation: true,
  },
  {
    id: 'background-job',
    prompt:
      '使用异步执行运行现成 worker.mjs，只启动一次。等待后台任务真实结束，读取 result.json 并核对，然后生成 summary.json，格式 {count,total}，total 为 result.json 中各 value 的和。后台结果未知时不要重复启动。保持 worker.mjs 和 jobs.json 不变。',
    files: {
      'jobs.json': JSON.stringify([7, 3, 19, 5, 11, 2, 17, 13]),
      'worker.mjs':
        "import {readFile,writeFile,appendFile} from 'node:fs/promises'; import {setTimeout} from 'node:timers/promises'; await appendFile('launches.txt','started\\n'); const jobs=JSON.parse(await readFile('jobs.json','utf8')); const out=[]; for (const [id,n] of jobs.entries()) { await setTimeout(100); out.push({id,value:n*n+id}); } await writeFile('result.json',JSON.stringify(out)); console.log('job-completed');\n",
    },
    grade: String.raw`${imports} const expected=[7,3,19,5,11,2,17,13].map((n,id)=>({id,value:n*n+id})); assert.deepEqual(JSON.parse(await readFile(join(root,'result.json'),'utf8')),expected); assert.equal(await readFile(join(root,'launches.txt'),'utf8'),'started\n'); assert.deepEqual(JSON.parse(await readFile(join(root,'summary.json'),'utf8')),{count:8,total:expected.reduce((sum,x)=>sum+x.value,0)});`,
    preserve: ['worker.mjs', 'jobs.json'],
    requireAsync: true,
  },
]
export const suiteHash = createHash('sha256').update(JSON.stringify(cases)).digest('hex')
