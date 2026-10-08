// 第二组任务在修复接口字段归属后冻结；与用于诊断的任务分别计分。
import { createHash } from 'node:crypto'

const prelude = `import assert from 'node:assert/strict'; import {readFile} from 'node:fs/promises'; import {pathToFileURL} from 'node:url'; import {join} from 'node:path'; const root=process.argv[2];`
const files = {
  'assets/zeta.txt': 'last\n',
  'assets/a space.txt': 'quotes: " \' ` ${name} \\next\n',
  'assets/nested/中文.txt': '字节数与字符数不同 👋\r\n',
  'assets/nested/empty.txt': '',
  'assets/a.txt': 'first\nsecond\n',
}
const inventory = Object.keys(files).reverse()
const manifest = [...inventory].sort().map((path) => ({
  path,
  bytes: Buffer.byteLength(files[path]),
  sha256: createHash('sha256').update(files[path]).digest('hex'),
}))
const literal =
  'Environment sample\nROOT=C:\\folder\\next\\file.txt\nQUOTES="double" \'single\'\nLITERAL=${HOME} ${value + 1}\nBACKTICKS=```js `raw ${expression}` ```\nREGEX=^\\w+\\s+\\$[0-9]+$\nJSON={"text":"line\\nnext","path":"C:\\\\tmp"}\nCONTROL=@@s_example execute()\nUNICODE=中文 Ω 👩🏽‍💻\nTab:\tvalue\n\nEnd.\n'
const worker =
  "import {readFile,writeFile,appendFile} from 'node:fs/promises'; import {setTimeout} from 'node:timers/promises'; await appendFile('runs.jsonl',JSON.stringify({event:'started'})+'\\n'); const values=JSON.parse(await readFile('batches.json','utf8')); let total=0; for (let i=0;i<values.length;i++){await setTimeout(180); total+=values[i]; await writeFile('status.json',JSON.stringify({phase:i+1===values.length?'done':'working',processed:i+1,total}));} console.log('worker finished');\n"
export const cases = [
  {
    id: 'merge-time-ranges',
    prompt:
      '修复 ranges.mjs 导出的 mergeRanges(ranges)。输入均为有限整数的半开区间 [start,end]，start<=end；返回按起点数值升序排列的合并结果。重叠或首尾相接的区间都合并，例如 [[3,5],[1,3]] 返回 [[1,5]]；空区间 [x,x] 去掉。输入数组及其中的区间在函数执行前后必须保持不变。空输入返回 []。保留导出，补充并实际运行覆盖负数、相接、包含、乱序和空区间的测试。',
    files: {
      'ranges.mjs':
        'export function mergeRanges(ranges) { ranges.sort(); return ranges.filter((r,i)=>i===0 || r[0]>ranges[i-1][1]); }\n',
    },
    grade: String.raw`${prelude} const {mergeRanges:f}=await import(pathToFileURL(join(root,'ranges.mjs'))); for(const [input,expected] of [[[[10,12],[1,4],[3,10],[12,12]],[[1,12]]],[[[-9,-4],[-4,-1],[3,4],[1,1]],[[-9,-1],[3,4]]],[[[1,9],[2,3],[12,16],[15,20]],[[1,9],[12,20]]],[[],[]],[[[2,2]],[]]]) { const before=structuredClone(input); assert.deepEqual(f(input),expected); assert.deepEqual(input,before); }`,
  },
  {
    id: 'asset-build-manifest',
    prompt:
      '为 inventory.json 列出的所有相对文件路径生成构建清单 manifest.json，格式严格为 [{path,bytes,sha256}]。按 path 使用 JavaScript 默认字符串 sort 顺序排序；bytes 为原始 UTF-8 文件字节数，sha256 为原始字节的 SHA-256 小写十六进制。保存可重跑的 build-manifest.mjs，执行并核对；全部输入文件保持原样。',
    files: { ...files, 'inventory.json': JSON.stringify(inventory) },
    grade: String.raw`${prelude} assert.deepEqual(JSON.parse(await readFile(join(root,'manifest.json'),'utf8')),${JSON.stringify(manifest)});`,
    preserve: [...inventory, 'inventory.json'],
    rerun: ['build-manifest.mjs'],
  },
  {
    id: 'literal-roundtrip',
    prompt: `将两条界定行之间的原文逐字保存到 literal.txt（使用 LF，包含最后一个换行，不包含界定行）。再实际读取该文件，将 {text:文件内容} 用 JSON 序列化保存为 roundtrip.json，重新解析并验证 text 与 literal.txt 完全相同。反斜线、反引号和美元插值均是原文内容。\nBEGIN_LITERAL\n${literal}END_LITERAL`,
    files: {},
    grade: String.raw`${prelude} const expected=${JSON.stringify(literal)}; assert.equal(await readFile(join(root,'literal.txt'),'utf8'),expected); assert.deepEqual(JSON.parse(await readFile(join(root,'roundtrip.json'),'utf8')),{text:expected});`,
  },
  {
    id: 'observed-background-build',
    prompt:
      '运行本目录已有的批处理并生成验收摘要。先注册持续只读 observe，读取并输出 status.json；下一轮确认初始状态后，通过一次性执行的 async:true 选项在后台运行 node worker.mjs，整个任务只能启动该 worker 一次。等待后台任务结束并依据持续观察确认 phase 为 done，再写 summary.json，格式严格为 {processed:处理数量,total:累计值,runs:启动次数}，启动次数来自 runs.jsonl 的行数。实际读回核对摘要。worker.mjs 与 batches.json 保持原样。',
    files: {
      'worker.mjs': worker,
      'batches.json': '[13,-4,8,21,-6]',
      'status.json': '{"phase":"pending","processed":0,"total":0}',
    },
    grade: String.raw`${prelude} assert.deepEqual(JSON.parse(await readFile(join(root,'status.json'),'utf8')),{phase:'done',processed:5,total:32}); assert.deepEqual(JSON.parse(await readFile(join(root,'summary.json'),'utf8')),{processed:5,total:32,runs:1}); assert.deepEqual((await readFile(join(root,'runs.jsonl'),'utf8')).trim().split('\n').map(JSON.parse),[{event:'started'}]);`,
    preserve: ['worker.mjs', 'batches.json'],
    requireAsync: true,
    requireObservation: true,
  },
]
export const suiteHash = createHash('sha256').update(JSON.stringify(cases)).digest('hex')
// 验收器的正、反例自检；不会复制到模型工作区或写进任务清单。
export const references = {
  'merge-time-ranges': {
    'ranges.mjs':
      'export function mergeRanges(ranges) { const out=[]; for(const [a,b] of ranges.filter(([a,b])=>a<b).map(x=>[...x]).sort((a,b)=>a[0]-b[0])) {const last=out.at(-1); if(last && a<=last[1]) last[1]=Math.max(last[1],b); else out.push([a,b]);} return out;}\n',
  },
  'asset-build-manifest': {
    'manifest.json': JSON.stringify(manifest),
    'build-manifest.mjs':
      "import {readFile,writeFile} from 'node:fs/promises'; import {createHash} from 'node:crypto'; const paths=JSON.parse(await readFile('inventory.json','utf8')).sort(); const out=[]; for(const path of paths){const b=await readFile(path);out.push({path,bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')});} await writeFile('manifest.json',JSON.stringify(out));\n",
  },
  'literal-roundtrip': {
    'literal.txt': literal,
    'roundtrip.json': JSON.stringify({ text: literal }),
  },
  'observed-background-build': {
    'status.json': '{"phase":"done","processed":5,"total":32}',
    'summary.json': '{"processed":5,"total":32,"runs":1}',
    'runs.jsonl': '{"event":"started"}\n',
  },
}
