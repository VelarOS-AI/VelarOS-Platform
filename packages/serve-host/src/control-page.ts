export const VelarHostControlHtml: string = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Velar Host</title>
  <link rel="stylesheet" href="/control.css">
</head>
<body>
  <main>
    <header>
      <h1>Velar Host</h1>
      <span id="host-state" class="badge"><span class="status-dot"></span>正在连接</span>
    </header>

    <section class="panel summary" aria-label="运行状态">
      <div class="summary-row">
        <span>内核</span>
        <div><strong id="process-value">—</strong><small id="uptime-value">—</small></div>
      </div>
      <div class="summary-row">
        <span>插件</span>
        <div><strong id="extension-value">—</strong><small id="extension-provider">—</small></div>
      </div>
      <div class="summary-row">
        <span>工作区</span>
        <div><strong id="workspace-value">—</strong><small id="workspace-path">—</small></div>
      </div>
    </section>

    <section class="panel connection-panel">
      <div class="panel-title">
        <h2>浏览器插件</h2>
        <span id="extension-state-chip" class="status-chip">等待配对</span>
      </div>
      <div class="pair-card">
        <div class="pair-main">
          <div class="pair-code-block">
            <span>配对码</span>
            <div class="code-row">
              <strong id="pairing-code">—</strong>
              <button id="copy-pairing" type="button">复制</button>
            </div>
          </div>
          <p id="pairing-value">正在获取配对状态…</p>
        </div>
        <div class="button-row">
          <button id="new-pairing" type="button">新配对码</button>
          <button id="disconnect-extension" type="button" class="danger">断开</button>
        </div>
      </div>
    </section>

    <section class="panel">
      <div class="panel-title">
        <h2>权限</h2>
        <button id="save-config" type="button" class="primary" disabled>保存</button>
      </div>
      <div class="permission-groups">
        <details class="permission-group">
          <summary><span><strong>项目文件</strong><small>读取与修改当前工作区</small></span><span class="disclosure-arrow">›</span></summary>
          <div class="toggles">
            <label><span><strong>读取</strong><small>搜索、状态和 diff</small></span><input id="workspace-read" type="checkbox"></label>
            <label><span><strong>修改</strong><small>编辑、校验与回滚</small></span><input id="workspace-write" type="checkbox"></label>
          </div>
        </details>
        <details class="permission-group">
          <summary><span><strong>系统能力</strong><small>状态、文件与命令</small></span><span class="disclosure-arrow">›</span></summary>
          <div class="toggles">
            <label><span><strong>查看状态</strong><small>系统概览、进程与后台任务</small></span><input id="system-observe" type="checkbox"></label>
            <label><span><strong>读取文件</strong><small>工作区外的列出与搜索</small></span><input id="system-read" type="checkbox"></label>
            <label><span><strong>修改文件</strong><small>工作区外的创建与精确修改</small></span><input id="system-write" type="checkbox"></label>
            <label><span><strong>执行操作</strong><small>运行命令、打开文件或应用</small></span><input id="system-execute" type="checkbox"></label>
          </div>
        </details>
        <details class="permission-group">
          <summary><span><strong>电脑</strong><small>屏幕观察与交互控制</small></span><span class="disclosure-arrow">›</span></summary>
          <div class="toggles">
            <label><span><strong>观察</strong><small>屏幕尺寸和截图</small></span><input id="computer-observe" type="checkbox"></label>
            <label><span><strong>控制</strong><small>移动、点击、输入和按键</small></span><input id="computer-control" type="checkbox"></label>
          </div>
        </details>
      </div>
    </section>

    <section class="panel computer-panel">
        <div class="panel-title">
          <h2>电脑控制</h2>
          <span id="computer-state-chip" class="status-chip neutral">未检查</span>
        </div>
        <p id="computer-value">尚未检查运行时与系统权限。</p>
        <div id="permission-list" class="permission-list" hidden>
          <span id="accessibility-value">辅助功能 —</span>
          <span id="screen-recording-value">屏幕录制 —</span>
        </div>
        <div class="button-row">
          <button id="probe-computer" type="button">检查系统权限</button>
          <button id="install-computer" type="button">安装或修复运行时</button>
        </div>
    </section>

    <details class="panel diagnostics-panel">
      <summary>详细信息</summary>
      <div class="diagnostics-content">
        <dl>
          <div><dt>Kernel</dt><dd id="kernel-value">—</dd></div>
          <div><dt>模块</dt><dd id="module-value">—</dd></div>
          <div><dt>设备</dt><dd id="device-value">尚未连接</dd></div>
          <div><dt>Bridge</dt><dd id="bridge-value">—</dd></div>
          <div><dt>活动会话</dt><dd id="surface-value">0</dd></div>
          <div><dt>最近活动</dt><dd id="activity-value">尚无</dd></div>
          <div><dt>数据目录</dt><dd id="data-root-value">—</dd></div>
          <div><dt>配置版本</dt><dd id="revision-value">—</dd></div>
          <div><dt>控制地址</dt><dd id="control-value">—</dd></div>
        </dl>
        <label class="roots">
          <span>Computer 资源目录（每行一个）</span>
          <textarea id="resource-roots" rows="3" spellcheck="false"></textarea>
        </label>
      </div>
    </details>

    <p id="notice" role="status" aria-live="polite"></p>
  </main>
  <script src="/control.js" defer></script>
</body>
</html>
`

export const VelarHostControlCss: string = `
:root {
  color-scheme: light dark;
  font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --bg: #f5f5f5;
  --panel: #fff;
  --panel-soft: #f4f4f4;
  --text: #202123;
  --muted: #737373;
  --line: #e8e8e8;
  --accent: #2563eb;
  --accent-soft: #eef3ff;
  --ok: #168657;
  --ok-soft: #eaf7f0;
  --warn: #9a5b00;
  --warn-soft: #fff5e5;
  --danger: #b42318;
}
* { box-sizing: border-box; }
body { margin: 0; color: var(--text); background: var(--bg); }
main { width: min(640px, calc(100% - 28px)); margin: 0 auto; padding: 34px 0 60px; }
header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 18px; padding: 0 2px; }
h1 { margin: 0; font-size: 22px; letter-spacing: -.025em; }
h2 { margin: 0; font-size: 15px; letter-spacing: -.01em; }
p { margin: 5px 0; color: var(--muted); }
small { color: var(--muted); }
.badge, .status-chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  width: max-content;
  padding: 7px 10px;
  color: var(--ok);
  background: var(--ok-soft);
  border-radius: 999px;
  font-size: 12px;
  font-weight: 750;
  white-space: nowrap;
}
.status-dot { width: 7px; height: 7px; background: currentColor; border-radius: 50%; }
.badge.offline, .status-chip.warning { color: var(--warn); background: var(--warn-soft); }
.status-chip.neutral { color: var(--muted); background: var(--panel-soft); }
.panel {
  margin-bottom: 10px;
  padding: 16px;
  background: var(--panel);
  border: 0;
  border-radius: 14px;
}
.summary { padding-top: 8px; padding-bottom: 8px; }
.summary-row { display: grid; grid-template-columns: 74px minmax(0, 1fr); gap: 12px; padding: 9px 0; }
.summary-row + .summary-row { border-top: 1px solid var(--line); }
.summary-row > span, .pair-card span { color: var(--muted); }
.summary-row strong, .summary-row small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.panel-title { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 12px; }
.pair-card { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 13px; background: var(--panel-soft); border-radius: 11px; }
.pair-main { min-width: 0; }
.connection-panel[data-connected="true"] .pair-code-block { display: none; }
.connection-panel[data-connected="true"] #new-pairing { display: none; }
.code-row { display: flex; align-items: center; gap: 10px; }
.code-row strong {
  color: var(--accent);
  font: 700 25px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: .12em;
}
.pair-card .button-row { justify-content: flex-end; margin-top: 0; }
.permission-groups { display: grid; gap: 1px; overflow: hidden; background: var(--line); border-radius: 11px; }
.permission-group { background: var(--panel-soft); }
.permission-group > summary { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 13px; cursor: pointer; list-style: none; }
.permission-group > summary::-webkit-details-marker { display: none; }
.permission-group > summary strong, .permission-group > summary small { display: block; }
.disclosure-arrow { color: var(--muted); font-size: 20px; line-height: 1; transform: rotate(0deg); transition: transform 160ms ease; }
.permission-group[open] > summary .disclosure-arrow { transform: rotate(90deg); }
.toggles { display: grid; gap: 1px; background: var(--line); border-top: 1px solid var(--line); }
.toggles label { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 11px 13px 11px 24px; background: var(--panel); }
label strong, label small { display: block; }
input[type=checkbox] { width: 42px; height: 24px; accent-color: var(--accent); }
.permission-list { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 12px; }
.permission-list span { padding: 5px 8px; color: var(--muted); background: var(--panel-soft); border-radius: 8px; font-size: 12px; font-weight: 650; }
.permission-list span.allowed { color: var(--ok); background: var(--ok-soft); }
dl { display: grid; gap: 8px; margin: 0; }
dl div { display: grid; grid-template-columns: 82px minmax(0, 1fr); gap: 10px; }
dt { color: var(--muted); }
dd { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
.diagnostics-panel { padding: 0; }
.diagnostics-panel > summary { padding: 15px 16px; color: var(--muted); cursor: pointer; font-weight: 650; list-style-position: inside; }
.diagnostics-content { padding: 0 16px 16px; }
.roots { display: block; margin-top: 10px; color: var(--muted); font-size: 12px; }
textarea { width: 100%; margin-top: 8px; padding: 10px 11px; resize: vertical; color: inherit; background: var(--panel-soft); border: 1px solid var(--line); border-radius: 10px; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
.button-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
button { min-height: 36px; padding: 0 13px; color: inherit; background: transparent; border: 1px solid #cdd5df; border-radius: 9px; font: inherit; font-size: 13px; font-weight: 700; cursor: pointer; }
button:hover:not(:disabled) { border-color: #8b9bad; background: color-mix(in srgb, var(--text) 3%, transparent); }
button:disabled { cursor: default; opacity: .48; }
#save-config:disabled { visibility: hidden; }
button.primary { color: #fff; background: var(--accent); border-color: var(--accent); }
button.danger { color: var(--danger); }
#notice { min-height: 22px; margin: 12px 2px 0; color: var(--ok); font-size: 13px; font-weight: 650; }
#notice.error { color: var(--danger); }
@media (max-width: 520px) {
  main { width: min(100% - 20px, 640px); padding-top: 22px; }
  .pair-card { align-items: stretch; flex-direction: column; }
  .pair-card .button-row { justify-content: flex-start; }
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #171717;
    --panel: #242424;
    --panel-soft: #2c2c2c;
    --text: #f1f1f1;
    --muted: #aaa;
    --line: #383838;
    --accent: #6ea2ff;
    --accent-soft: #24334d;
    --ok: #6bd6a3;
    --ok-soft: #21362c;
    --warn: #ffc46b;
    --warn-soft: #3a2e1e;
  }
  button { border-color: #3a4652; }
}
`

export const VelarHostControlJs: string = `
(() => {
  const byId = (id) => document.getElementById(id)
  const tokenFromHash = new URLSearchParams(location.hash.slice(1)).get('token')
  if (tokenFromHash) {
    sessionStorage.setItem('velarHostControlToken', tokenFromHash)
    history.replaceState(null, '', location.pathname)
  }
  const token = sessionStorage.getItem('velarHostControlToken') || ''
  let currentConfig = null
  let dirty = false
  let refreshErrorVisible = false

  async function api(path, options = {}) {
    if (!token) throw new Error('缺少控制令牌。请在终端运行 velaros serve control，并使用输出的完整地址。')
    const response = await fetch(path, {
      ...options,
      headers: {
        Authorization: 'Bearer ' + token,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.error || ('请求失败：HTTP ' + response.status))
    return body
  }

  function setNotice(message, error = false) {
    byId('notice').textContent = message || ''
    byId('notice').classList.toggle('error', error)
  }

  function formatUptime(startedAt) {
    const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
    if (seconds < 60) return '已运行 ' + seconds + ' 秒'
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return '已运行 ' + minutes + ' 分钟'
    const hours = Math.floor(minutes / 60)
    return '已运行 ' + hours + ' 小时 ' + (minutes % 60) + ' 分钟'
  }

  function basename(path) {
    const parts = String(path || '').split(/[\\\\/]/u).filter(Boolean)
    return parts[parts.length - 1] || path || '—'
  }

  function formatActivity(activity) {
    if (!activity) return '尚无'
    const label = activity.toolName || activity.eventType
    const state = activity.status ? ' · ' + activity.status : ''
    return label + state + ' · ' + new Date(activity.at).toLocaleTimeString()
  }

  function markDirty() {
    dirty = true
    byId('save-config').disabled = false
    setNotice('权限设置尚未保存。')
  }

  function renderComputer(value) {
    const chip = byId('computer-state-chip')
    if (!value) {
      chip.textContent = '未检查'
      chip.className = 'status-chip neutral'
      byId('permission-list').hidden = true
      return
    }
    chip.textContent = value.available ? '运行时可用' : '需要处理'
    chip.className = value.available ? 'status-chip' : 'status-chip warning'
    byId('computer-value').textContent = value.available
      ? 'Computer 辅助进程与当前系统权限可用。'
      : '不可用 · ' + value.reason + (value.detail ? ' · ' + value.detail : '')
    const permissions = value.permissions || {}
    const accessibility = byId('accessibility-value')
    const screenRecording = byId('screen-recording-value')
    accessibility.textContent = '辅助功能 ' + (permissions.accessibility ? '已允许' : '未允许')
    screenRecording.textContent = '屏幕录制 ' + (permissions.screenRecording ? '已允许' : '未允许')
    accessibility.classList.toggle('allowed', Boolean(permissions.accessibility))
    screenRecording.classList.toggle('allowed', Boolean(permissions.screenRecording))
    byId('permission-list').hidden = false
  }

  function render(payload) {
    const host = payload.host
    const extension = host.extension
    currentConfig = payload.config.value
    document.querySelector('.connection-panel').dataset.connected = String(extension.connected)
    byId('host-state').textContent = '本机运行中'
    byId('host-state').classList.remove('offline')
    byId('process-value').textContent = 'v' + host.version + ' · PID ' + host.pid
    byId('uptime-value').textContent = formatUptime(host.startedAt)
    byId('kernel-value').textContent = 'v' + host.kernel.kernelVersion + ' · 协议 ' + host.kernel.protocolVersion
    byId('module-value').textContent = host.kernel.moduleIds.length + ' 个能力模块'
    byId('extension-value').textContent = extension.connected ? '已连接' : extension.deviceId ? '已配对，等待页面' : '等待配对'
    byId('extension-provider').textContent = extension.provider ? 'Provider · ' + extension.provider : 'ChatGPT / 网页模型'
    byId('workspace-value').textContent = basename(host.workspaceRoot)
    byId('workspace-path').textContent = host.workspaceRoot
    byId('workspace-path').title = host.workspaceRoot
    byId('revision-value').textContent = payload.config.revision
    byId('data-root-value').textContent = host.dataRoot
    byId('data-root-value').title = host.dataRoot
    byId('control-value').textContent = host.control.endpoint
    byId('bridge-value').textContent = extension.endpoint
    byId('bridge-value').title = extension.endpoint
    const extensionChip = byId('extension-state-chip')
    extensionChip.textContent = extension.connected ? '插件在线' : extension.deviceId ? '设备已保存' : '等待配对'
    extensionChip.className = extension.connected ? 'status-chip' : 'status-chip warning'
    byId('device-value').textContent = extension.deviceId
      ? (extension.provider || '网页模型') + ' · ' + extension.deviceId
      : '尚未连接'
    byId('surface-value').textContent = String(extension.surfaceCount || 0)
    byId('activity-value').textContent = formatActivity(extension.activity)
    byId('activity-value').title = extension.activity?.eventType || ''
    byId('pairing-code').textContent = extension.pairingCode || '—'
    byId('copy-pairing').disabled = !extension.pairingCode
    byId('pairing-value').textContent = extension.connected
      ? '已连接，可自动恢复。'
      : extension.pairingCode
        ? '有效期至 ' + new Date(extension.pairingExpiresAt).toLocaleTimeString()
        : extension.deviceId ? '设备已保存，等待网页连接。' : '生成配对码后在插件中输入。'
    if (!dirty) {
      byId('workspace-read').checked = currentConfig.capabilities.workspace.read
      byId('workspace-write').checked = currentConfig.capabilities.workspace.write
      byId('system-observe').checked = currentConfig.capabilities.system.observe
      byId('system-read').checked = currentConfig.capabilities.system.read
      byId('system-write').checked = currentConfig.capabilities.system.write
      byId('system-execute').checked = currentConfig.capabilities.system.execute
      byId('computer-observe').checked = currentConfig.capabilities.computer.observe
      byId('computer-control').checked = currentConfig.capabilities.computer.control
      byId('resource-roots').value = currentConfig.computer.resourceRoots.join('\\n')
      byId('save-config').disabled = true
    }
    renderComputer(payload.computerAvailability)
  }

  async function refresh() {
    try {
      render(await api('/v1/status'))
      if (refreshErrorVisible) {
        refreshErrorVisible = false
        setNotice('')
      }
    } catch (error) {
      refreshErrorVisible = true
      byId('host-state').textContent = '无法连接'
      byId('host-state').classList.add('offline')
      setNotice('连接已中断，正在重试。', true)
    }
  }

  async function copyPairingCode() {
    const value = byId('pairing-code').textContent.trim()
    if (!/^\\d{6}$/u.test(value)) return
    try {
      await navigator.clipboard.writeText(value)
      setNotice('配对码已复制。')
    } catch {
      const input = document.createElement('textarea')
      input.value = value
      input.setAttribute('readonly', '')
      input.style.position = 'fixed'
      input.style.opacity = '0'
      document.body.append(input)
      input.select()
      document.execCommand('copy')
      input.remove()
      setNotice('配对码已复制。')
    }
  }

  byId('workspace-write').addEventListener('change', () => {
    if (byId('workspace-write').checked) byId('workspace-read').checked = true
    markDirty()
  })
  byId('workspace-read').addEventListener('change', () => {
    if (!byId('workspace-read').checked) byId('workspace-write').checked = false
    markDirty()
  })
  byId('system-write').addEventListener('change', () => {
    if (byId('system-write').checked) byId('system-read').checked = true
    markDirty()
  })
  ;['system-observe', 'system-read', 'system-execute'].forEach((id) => {
    byId(id).addEventListener('change', () => {
      if (id === 'system-read' && !byId(id).checked) byId('system-write').checked = false
      markDirty()
    })
  })
  byId('computer-control').addEventListener('change', () => {
    if (byId('computer-control').checked) byId('computer-observe').checked = true
    markDirty()
  })
  byId('computer-observe').addEventListener('change', () => {
    if (!byId('computer-observe').checked) byId('computer-control').checked = false
    markDirty()
  })
  byId('resource-roots').addEventListener('input', markDirty)

  byId('save-config').addEventListener('click', async () => {
    const button = byId('save-config')
    button.disabled = true
    try {
      const next = {
        capabilities: {
          workspace: { read: byId('workspace-read').checked, write: byId('workspace-write').checked },
          system: {
            observe: byId('system-observe').checked,
            read: byId('system-read').checked,
            write: byId('system-write').checked,
            execute: byId('system-execute').checked,
          },
          computer: { observe: byId('computer-observe').checked, control: byId('computer-control').checked },
        },
        computer: {
          resourceRoots: byId('resource-roots').value
            .split('\\n')
            .map((value) => value.trim())
            .filter(Boolean),
        },
      }
      const confirmations = []
      if (!currentConfig.capabilities.workspace.write && next.capabilities.workspace.write && confirm('允许网页 Agent 修改当前工作区？')) confirmations.push('workspace-write')
      if (!currentConfig.capabilities.system.observe && next.capabilities.system.observe && confirm('允许网页 Agent 查看本机系统状态？')) confirmations.push('system-observe')
      if (!currentConfig.capabilities.system.read && next.capabilities.system.read && confirm('允许网页 Agent 读取工作区外的本机文件？')) confirmations.push('system-read')
      if (!currentConfig.capabilities.system.write && next.capabilities.system.write && confirm('允许网页 Agent 修改工作区外的本机文件？')) confirmations.push('system-write')
      if (!currentConfig.capabilities.system.execute && next.capabilities.system.execute && confirm('允许网页 Agent 运行本机命令并打开文件或应用？')) confirmations.push('system-execute')
      if (!currentConfig.capabilities.computer.observe && next.capabilities.computer.observe && confirm('允许网页 Agent 截取本机屏幕？')) confirmations.push('computer-observe')
      if (!currentConfig.capabilities.computer.control && next.capabilities.computer.control && confirm('允许网页 Agent 控制本机鼠标和键盘？')) confirmations.push('computer-control')
      const payload = await api('/v1/config', { method: 'PUT', body: JSON.stringify({ ...next, confirmations }) })
      dirty = false
      render(payload)
      setNotice('权限已保存，插件工具目录会自动更新。')
    } catch (error) {
      setNotice(error.message || String(error), true)
      button.disabled = false
    }
  })

  byId('copy-pairing').addEventListener('click', () => void copyPairingCode())
  byId('new-pairing').addEventListener('click', async () => {
    try {
      render(await api('/v1/extension/pairing', { method: 'POST' }))
      setNotice('已生成新的五分钟配对码。')
    } catch (error) {
      setNotice(error.message || String(error), true)
    }
  })
  byId('disconnect-extension').addEventListener('click', async () => {
    if (!confirm('断开插件并删除此 Host 保存的设备凭据？')) return
    try {
      render(await api('/v1/extension', { method: 'DELETE' }))
      setNotice('此 Host 的插件设备已清除。')
    } catch (error) {
      setNotice(error.message || String(error), true)
    }
  })
  byId('probe-computer').addEventListener('click', async () => {
    const button = byId('probe-computer')
    button.disabled = true
    try {
      render(await api('/v1/computer/probe', { method: 'POST' }))
      setNotice('Computer 状态已更新。')
    } catch (error) {
      setNotice(error.message || String(error), true)
    } finally {
      button.disabled = false
    }
  })
  byId('install-computer').addEventListener('click', async () => {
    if (!confirm('在 Velar Host 的独立数据目录中安装 Computer Python 运行时？')) return
    const button = byId('install-computer')
    button.disabled = true
    try {
      setNotice('正在安装隔离的 Computer 运行时，这可能需要几分钟。')
      render(await api('/v1/computer/install', { method: 'POST' }))
      setNotice('Computer 运行时已就绪，系统权限状态也已重新检查。')
    } catch (error) {
      setNotice(error.message || String(error), true)
    } finally {
      button.disabled = false
    }
  })

  void refresh()
  setInterval(() => void refresh(), 2500)
})()
`
