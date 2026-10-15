// 使用官方 TestsStream 事件，stdout/stderr 诊断不参与评分 JSON 的解析。
// https://nodejs.org/api/test.html#test-reporters
export default async function* report(source) {
  const cases = []
  const summaries = []
  const diagnostics = []
  for await (const { type, data } of source) {
    if (type === 'test:stdout' || type === 'test:stderr') process.stderr.write(data.message)
    if (type === 'test:diagnostic') diagnostics.push(data.message)
    if (type === 'test:summary' && data.file === undefined) summaries.push(data)
    if (type !== 'test:pass' && type !== 'test:fail') continue
    const error = data.details?.error
    cases.push({
      name: data.name,
      file: data.file,
      kind: data.details?.type,
      outcome: data.skip
        ? 'skipped'
        : data.todo
          ? 'todo'
          : type === 'test:pass'
            ? 'passed'
            : 'failed',
      failureType: error?.failureType,
      message: error?.message ?? '',
      text: String(error?.cause?.stack ?? error?.stack ?? error?.cause ?? ''),
    })
  }
  yield JSON.stringify({ schema: 'node-test-regression-1', summaries, cases, diagnostics }) + '\n'
}
