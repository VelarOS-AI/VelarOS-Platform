import { mountHtmlArtifact } from '../dist/index.js'

const defaultSample = `<artifact version="1" id="flight-card" title="Flight card">
<patch type="replace"><main id="artifact-root"></main></patch>
<patch type="append" target="#artifact-root"><p class="kicker">LIVE ARTIFACT</p><h2>Shanghai <span>→</span> Helsinki</h2></patch>
<patch type="append" target="#artifact-root"><div class="route"><div><small>PVG</small><strong>01:35</strong></div><i></i><div><small>HEL</small><strong>07:20</strong></div></div></patch>
<patch type="append" target="#artifact-root"><button id="check-in">Check in <b>→</b></button><p id="message">A generated interface, isolated from its host.</p></patch>
<patch type="style" id="base">:root{color-scheme:light}*{box-sizing:border-box}body{font-family:Inter,ui-sans-serif,system-ui;color:#171916}#artifact-root{padding:28px;border:1px solid #dfe5dd;border-radius:20px;background:linear-gradient(145deg,#fbfcf8,#eef5ed);box-shadow:0 18px 45px rgba(46,70,45,.09)}.kicker{margin:0 0 18px;color:#547458;font-size:11px;font-weight:700;letter-spacing:.16em}h2{margin:0;font-size:clamp(25px,5vw,44px);font-weight:560;letter-spacing:-.045em}h2 span{color:#8ca590}.route{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:18px;margin:30px 0}.route div{display:grid;gap:4px}.route div:last-child{text-align:right}.route small{color:#758075;font-size:11px;letter-spacing:.12em}.route strong{font-size:22px}.route i{height:1px;background:linear-gradient(90deg,#839a86 0 48%,transparent 48% 52%,#839a86 52%)}button{display:flex;width:100%;align-items:center;justify-content:space-between;border:0;border-radius:12px;padding:13px 15px;background:#1c251d;color:white;font:600 14px/1 system-ui;cursor:pointer}button:hover{background:#334636}#message{margin:14px 2px 0;color:#697168;font-size:12px}</patch>
<patch type="script" id="interactions">document.querySelector('#check-in')?.addEventListener('click',()=>{document.querySelector('#message').textContent='The iframe handled this interaction without host authority.'})</patch>
</artifact>`

const viewportFeedbackSample = `<artifact version="1" id="height-feedback" title="Height feedback fixture">
<patch type="replace"><main id="artifact-root"><p>Viewport feedback fixture</p></main></patch>
<patch type="style" id="feedback">html,body,#demo-artifact-root,#artifact-root{min-height:calc(100vh + 80px)}#artifact-root{padding:24px;background:#eef5ed}</patch>
</artifact>`

const sample =
  new URLSearchParams(window.location.search).get('fixture') === 'viewport-feedback'
    ? viewportFeedbackSample
    : defaultSample

const frameHost = document.querySelector('#frame-host')
const log = document.querySelector('#protocol-log')
const runButton = document.querySelector('#run')
const status = document.querySelector('#status')
let generation = 0

function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
}

const artifact = mountHtmlArtifact(frameHost, {
  title: 'Streaming HTML artifact preview',
  initialHeight: 240,
  maxHeight: 720,
  rootId: 'demo-artifact-root',
  designCss: 'html{background:transparent}body{padding:4px}',
  onEvent(event) {
    if (event.type === 'artifact-close') {
      status.textContent = 'Complete — interaction stays inside the sandbox'
    }
  },
  onError(error) {
    status.textContent = `${error.phase} report: ${error.message}`
  },
  onLink(url) {
    window.open(url, '_blank', 'noopener,noreferrer')
  },
})

async function* streamSample(activeGeneration) {
  for (let offset = 0; offset < sample.length; ) {
    if (activeGeneration !== generation) return
    const width = 4 + ((offset * 7) % 17)
    const chunk = sample.slice(offset, offset + width)
    offset += width
    log.textContent += chunk
    log.scrollTop = log.scrollHeight
    yield chunk
    await wait(16)
  }
}

async function replay() {
  generation += 1
  const activeGeneration = generation
  runButton.disabled = true
  status.textContent = 'Preparing sandbox…'
  log.textContent = ''

  try {
    await artifact.ready
    if (activeGeneration !== generation) return
    artifact.reset()
    status.textContent = 'Streaming model output…'
    await artifact.consume(streamSample(activeGeneration))
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : 'Unable to replay stream'
  } finally {
    if (activeGeneration === generation) runButton.disabled = false
  }
}

runButton.addEventListener('click', replay)
void replay()
