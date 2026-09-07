const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const directory = process.argv[2]
app.setPath('userData', path.join(directory, 'user-data'))
app.dock?.hide()
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 900, height: 600, show: false, frame: false,
    webPreferences: { backgroundThrottling: false, nodeIntegration: false, contextIsolation: true, sandbox: true } })
  const report = { results: [], errors: [] }
  const run = (source) => window.webContents.executeJavaScript(source)
  const click = async (selector) => {
    const point = await run(`(() => {const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw Error('Missing click target');const r=element.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
    window.webContents.sendInputEvent({ type: 'mouseMove', ...point })
    for (const type of ['mouseDown', 'mouseUp']) window.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point })
    await wait(70)
  }
  const escape = async () => {
    for (const type of ['keyDown', 'keyUp']) window.webContents.sendInputEvent({ type, keyCode: 'Escape' })
    await wait(70)
  }
  const expect = async (expression, message) => assert.equal(await run(expression), true, message)
  window.webContents.on('console-message', (event) => { if (event.level === 'error') report.errors.push(event.message) })
  try {
    for (const mode of ['eager', 'lazy']) {
      await window.loadFile(path.join(directory, mode, `${mode}.html`))
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await run('!!document.querySelector("#git button[data-state]")')) break
        await wait(50)
      }
      await click('#git button[data-state]')
      await wait(250)
      await expect('document.activeElement === document.querySelector(".velar-popover-content input")', `${mode}: Git search autofocus`)
      const appearance = await run(`(() => {const button=document.querySelector('#git button[data-state]');return Object.fromEntries([['button',button],['frame',button.closest('.velar-topbar-control-frame')],['popover',document.querySelector('.velar-popover-content')]].map(([key,element])=>{const style=getComputedStyle(element);return [key,Object.fromEntries(['borderWidth','borderColor','borderRadius','backgroundColor','boxShadow','padding','width','height','webkitAppRegion'].map(property=>[property,style[property]]))]}))})()`)
      assert.equal(appearance.button.borderWidth, '0px', `${mode}: trigger border`)
      assert.equal(appearance.frame.backgroundColor, 'rgba(0, 0, 0, 0)', `${mode}: frame background`)
      assert.equal(appearance.popover.webkitAppRegion, 'no-drag', `${mode}: popover drag exclusion`)
      fs.writeFileSync(path.join(directory, `${mode}.png`), (await window.webContents.capturePage()).toPNG())
      await click('.velar-popover-content input')
      await window.webContents.insertText('feature')
      await wait(70)
      await expect(`(() => {const p=document.querySelector('.velar-popover-content');return p.querySelector('input').value==='feature'&&p.textContent.includes('search')&&!p.querySelector('[title="main"]')})()`, `${mode}: branch filtering`)
      await escape()
      await expect('!document.querySelector(".velar-popover-content") && document.activeElement===document.querySelector("#git button[data-state]")', `${mode}: Escape returns Git trigger focus`)
      await click('#git button[data-state]')
      await expect('document.querySelector(".velar-popover-content input").value === ""', `${mode}: reopened search resets`)
      await click('#outside-focus')
      await expect('!document.querySelector(".velar-popover-content") && document.activeElement.id==="outside-focus"', `${mode}: outside input focus`)
      await click('#focus-trigger')
      await expect('window.focusEvents.length===1 && window.focusEvents[0].visibility==="visible" && window.focusEvents[0].rects>0 && document.activeElement.id==="focus-target"', `${mode}: visible open callback`)
      await run('window.dispatchEvent(new Event("resize"))')
      await wait(70)
      await expect('window.focusEvents.length===1', `${mode}: positioning must not repeat open callback`)
      await click('#nested-trigger')
      await expect('document.activeElement.id==="focus-target"', `${mode}: generic popup does not choose an input to autofocus`)
      await click('#nested-target')
      await expect('document.querySelectorAll(".velar-popover-content").length===2 && document.activeElement.id==="nested-target" && window.focusEvents.length===1', `${mode}: nested portal interaction`)
      await click('#nested-trigger')
      await escape()
      await expect('document.activeElement.id==="focus-trigger"', `${mode}: generic close restores trigger`)
      await click('#focus-trigger')
      await expect('window.focusEvents.length===2 && document.activeElement.id==="focus-target"', `${mode}: callback once on reopen`)
      await click('#outside-focus')
      await expect('!document.querySelector(".velar-popover-content") && document.activeElement.id==="outside-focus"', `${mode}: generic outside focus`)
      await click('#focus-trigger')
      await run('window.preventCloseFocus=true')
      await escape()
      await expect('!document.querySelector(".velar-popover-content") && document.activeElement.id!=="focus-trigger"', `${mode}: canceled close autofocus`)
      report.results.push({ mode, appearance, interactions: 'passed', focusEvents: await run('window.focusEvents') })
    }
    assert.deepEqual(report.results[0].appearance, report.results[1].appearance, 'eager/lazy computed appearance')
    assert.deepEqual(report.errors, [], 'renderer console errors')
    console.log('Popover runtime: eager/lazy appearance, Git interactions, focus lifecycle passed.')
  } catch (error) {
    report.failure = error.stack
    fs.writeFileSync(path.join(directory, 'failure.png'), (await window.webContents.capturePage()).toPNG())
    console.error(error)
    process.exitCode = 1
  } finally {
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2))
    window.destroy()
    app.exit(process.exitCode || 0)
  }
}).catch((error) => { console.error(error); app.exit(1) })
