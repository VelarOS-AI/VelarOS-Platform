// Real Chromium regression: an isolated, hidden window; no user browser/profile is used.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { app, BrowserWindow } from 'electron'

import { createElectronBrowserRuntime } from '../../../dist/browser/electron.js'
import { browserOperations } from '../../../dist/browser/index.js'

app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  const runtime = createElectronBrowserRuntime()
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'velaros-fill-'))
  const server = http.createServer()
  try {
    const cases = [
      ['date', '2010-12-01', '2011-12-09'],
      ['time', '10:30', '18:45'],
      ['datetime-local', '2010-12-01T10:30', '2011-12-09T18:45'],
      ['month', '2010-12', '2011-09'],
      ['week', '2010-W48', '2011-W49'],
      ['number', '12', '-2.5'],
      ['text', 'old', 'new 😀'],
      ['email', 'old@example.test', 'new@example.test'],
    ]
    const html = `<html><body>${cases.map(([type, value]) => `<input id="${type}" type="${type}" value="${value}" step="any">`).join('')}<textarea id="textarea">old</textarea><div contenteditable="true" id="editor">old</div><input id="readonly" type="date" value="2010-12-01" readonly><input id="disabled" type="date" value="2010-12-01" disabled><fieldset disabled><input id="inherited-disabled" type="date" value="2010-12-01"></fieldset><input id="replaced" type="date" value="2010-12-01"><iframe srcdoc="<input id='framed-date' type='date' value='2010-12-01'>"></iframe><script>
    window.changes = {};
    for (const input of document.querySelectorAll('input, textarea')) {
      const native = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value');
      let tracked = input.value;
      Object.defineProperty(input, 'value', { configurable: true, get() { return native.get.call(this) }, set(value) { tracked = String(value); native.set.call(this, value) } });
      input.addEventListener('input', () => { if (native.get.call(input) !== tracked) { tracked = native.get.call(input); window.changes[input.id] = tracked } });
    }
    document.getElementById('replaced').addEventListener('change', (event) => { const replacement = document.createElement('input'); replacement.type = 'date'; replacement.id = 'replaced'; replacement.value = '2012-01-01'; event.target.replaceWith(replacement) });
  </script></body></html>`
    server.on('request', (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(html)
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    await window.loadURL(`http://127.0.0.1:${server.address().port}/`)
    const context = { url: window.webContents.getURL(), workspaceRoot }
    const external = process.argv
      .find((item) => item.startsWith('--external='))
      ?.slice('--external='.length)
    if (external)
      await runtime.launchExternalBrowserPage('fill-probe', context, {
        executablePath: external,
        preferRunningBrowser: false,
        args: ['--headless=new', '--window-size=1000,700'],
      })
    else await runtime.presentPage('fill-probe', context, window.webContents.id)
    const ctx = {
      abortSignal: new AbortController().signal,
      browser: {
        isActive: () => true,
        getContext: () => context,
        ...Object.fromEntries(
          ['performTargetAction', 'insertText', 'pressKey', 'evaluateScript'].map((method) => [
            method,
            (options) => runtime[method]('fill-probe', context, options),
          ])
        ),
      },
    }
    const evaluate = (script) => browserOperations.evaluate({ script }, ctx)
    for (const id of ['readonly', 'disabled', 'inherited-disabled']) {
      const result = await browserOperations.fill({ target: `#${id}`, value: '2011-12-09' }, ctx)
      assert.equal(result.matched, false, id)
      assert.equal(await evaluate(`document.getElementById('${id}').value`), '2010-12-01')
    }
    await browserOperations.fill({ target: '#date', value: '2011-12-09' }, ctx)
    const invalid = await browserOperations.fill({ target: '#date', value: 'not-a-date' }, ctx)
    assert.equal(invalid.matched, false)
    assert.equal(await evaluate("document.getElementById('date').value"), '2011-12-09')
    console.info('PASS readonly, disabled and invalid date: no mutation')
    const normalized = await browserOperations.fill(
      { target: '#datetime-local', value: '2011-12-09T18:45:00' },
      ctx
    )
    assert.equal(normalized.matched, true)
    assert.equal(normalized.controlState.value, '2011-12-09T18:45')
    const replaced = await browserOperations.fill({ target: '#replaced', value: '2011-12-09' }, ctx)
    assert.equal(replaced.controlState.value, '2012-01-01')
    for (const [type, , value] of [
      ...(external ? cases : cases.slice(0, 5)),
      ...(external
        ? [
            ['textarea', '', 'new lines\nnext'],
            ['editor', '', 'rich text'],
          ]
        : []),
    ]) {
      const filled = await browserOperations.fill({ target: `#${type}`, value }, ctx)
      assert.equal(filled.matched, true, type)
      assert.equal(filled.controlState.value, value, type)
      if (type !== 'editor')
        assert.equal(
          await evaluate(`window.changes[${JSON.stringify(type)}]`),
          value,
          `${type}: controlled input event`
        )
      const cleared = await browserOperations.fill({ target: `#${type}`, value: '' }, ctx)
      assert.equal(cleared.controlState.value, '', `${type}: clear`)
      console.info(`PASS ${type}: replace, controlled event, clear`)
    }
    const framed = await browserOperations.fill(
      { target: { css: '#framed-date', frame: { css: 'iframe' } }, value: '2011-12-09' },
      ctx
    )
    assert.equal(framed.matched, true)
    assert.equal(framed.controlState.value, '2011-12-09')
    console.info('PASS normalized date, replacement node and iframe value')
    if (!external)
      console.info(
        'Keyboard controls require --external=<Chrome executable> for an isolated headless browser; hidden Electron does not deliver key events on every host.'
      )
    process.exitCode = 0
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    await runtime.closeSession('fill-probe')
    runtime.dispose()
    if (!window.isDestroyed()) window.destroy()
    await rm(workspaceRoot, { recursive: true, force: true })
    await new Promise((resolve) => server.close(resolve))
    app.exit(process.exitCode ?? 0)
  }
})
