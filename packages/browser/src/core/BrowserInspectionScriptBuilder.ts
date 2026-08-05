import { browserLoginDetectionScriptFragment } from './BrowserLoginDetection'

/** 构造页面结构检查脚本。 */
class BrowserInspectionScriptBuilder {
  /** 提取页面标题、正文、标题、链接、动作和表单字段。 */
  public buildInspectionScript(args: {
    includeHtml: boolean
    maxTextChars: number
    maxHtmlChars: number
    maxElements: number
    ignoreSelectors?: string[]
  }): string {
    const ignoreSelectors = args.ignoreSelectors?.slice(0, 50) ?? []
    return `(() => {
${browserLoginDetectionScriptFragment}
      const ignoreSelectors = ${JSON.stringify(ignoreSelectors)}
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim()
      const escapeCss = (value) => {
        if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(String(value))
        return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&')
      }
      const getNodeWindow = (node) => node?.ownerDocument?.defaultView || window
      const isElementNode = (node) => !!node && node.nodeType === 1 && typeof node.tagName === 'string'
      const isNodeInstance = (node, constructorName) => {
        const view = getNodeWindow(node)
        const ctor = view?.[constructorName]
        return typeof ctor === 'function' && node instanceof ctor
      }
      const isHtmlAnchorElement = (node) => isNodeInstance(node, 'HTMLAnchorElement')
      const isHtmlIFrameElement = (node) => isNodeInstance(node, 'HTMLIFrameElement')
      const isHtmlInputElement = (node) => isNodeInstance(node, 'HTMLInputElement')
      const isHtmlLabelElement = (node) => isNodeInstance(node, 'HTMLLabelElement')
      const isHtmlOptionElement = (node) => isNodeInstance(node, 'HTMLOptionElement')
      const ignoredNodesByDocument = new WeakMap()
      const readIgnoredNodes = (ownerDocument) => {
        if (!ownerDocument || ignoreSelectors.length === 0) return []
        const existing = ignoredNodesByDocument.get(ownerDocument)
        if (existing) return existing
        const ignored = []
        for (const selector of ignoreSelectors) {
          try {
            ignored.push(...Array.from(ownerDocument.querySelectorAll(selector)))
          } catch {
            // 忽略无效 ignoreSelectors；噪音过滤不能打断页面检查。
          }
        }
        ignoredNodesByDocument.set(ownerDocument, ignored)
        return ignored
      }
      const isIgnoredNode = (node) => {
        if (!isElementNode(node)) return false
        const ownerDocument = node.ownerDocument || document
        return readIgnoredNodes(ownerDocument).some((ignored) => ignored === node || ignored.contains(node))
      }
      const truncate = (value, max) => {
        const text = String(value || '')
        return {
          value: text.length > max ? text.slice(0, max) : text,
          truncated: text.length > max,
        }
      }
      const refByNode = new WeakMap()
      const snapshotLines = []
      const maxSnapshotLines = Math.max(80, ${args.maxElements} + 80)
      let nextRefIndex = 1
      const escapeSnapshotText = (value) => String(value || '').replace(/"/g, '\\"')
      const formatSnapshotAttribute = (name, value = true) => {
        if (value === false || value == null || value === '') return null
        if (value === true) return name
        const text = escapeSnapshotText(value).slice(0, 80)
        return /[\\s,\\[\\]"]/.test(text) ? name + '="' + text + '"' : name + '=' + text
      }
      const readSnapshotState = (node, attributes) => {
        const state = {}
        const tagName = node.tagName ? node.tagName.toLowerCase() : ''
        const attributeType = normalize(attributes.type).toLowerCase()
        if (attributeType) state.type = attributeType
        if (attributes.placeholder) state.placeholder = attributes.placeholder
        if (node.hasAttribute('required') || node.getAttribute('aria-required') === 'true') state.required = true
        if (node.hasAttribute('disabled') || node.getAttribute('aria-disabled') === 'true') state.disabled = true

        const ariaExpanded = normalize(node.getAttribute('aria-expanded')).toLowerCase()
        if (ariaExpanded === 'true' || ariaExpanded === 'false') state.expanded = ariaExpanded
        const ariaSelected = normalize(node.getAttribute('aria-selected')).toLowerCase()
        if (ariaSelected === 'true' || ariaSelected === 'false') state.selected = ariaSelected
        const ariaChecked = normalize(node.getAttribute('aria-checked')).toLowerCase()
        if (ariaChecked === 'true' || ariaChecked === 'false' || ariaChecked === 'mixed') state.checked = ariaChecked

        if (isHtmlInputElement(node)) {
          const inputType = normalize(node.type).toLowerCase()
          if (inputType && !state.type) state.type = inputType
          if (inputType === 'file') {
            if (attributes.accept) state.accept = attributes.accept
            if (node.hasAttribute('multiple')) state.multiple = true
          }
          if (['checkbox', 'radio'].includes(inputType)) state.checked = String(node.checked)
          if (node.value && !['password', 'hidden', 'checkbox', 'radio', 'file'].includes(inputType)) state.value = node.value
        } else if (tagName === 'textarea' && node.value) {
          state.value = node.value
        } else if (tagName === 'select' && node.value) {
          state.value = node.value
        } else if (isHtmlOptionElement(node)) {
          state.selected = String(node.selected)
          if (node.value) state.value = node.value
        }

        const labelledControl = isHtmlLabelElement(node) && isHtmlInputElement(node.control) ? node.control : null
        const nestedCheckable = isHtmlLabelElement(node) ? node.querySelector('input[type="checkbox"], input[type="radio"]') : null
        const checkableControl = labelledControl || (isHtmlInputElement(nestedCheckable) ? nestedCheckable : null)
        if (checkableControl) {
          const checkableType = normalize(checkableControl.type).toLowerCase()
          if (['checkbox', 'radio'].includes(checkableType)) {
            state.type = checkableType
            state.checked = String(checkableControl.checked)
            if (checkableControl.disabled) state.disabled = true
            if (checkableControl.hasAttribute('required') || checkableControl.getAttribute('aria-required') === 'true') state.required = true
          }
        }
        return state
      }
      const formatSnapshotLine = (ref, node, role, text, attributes, state) => {
        const labelText = normalize(text).slice(0, 120)
        const label = labelText ? ' "' + escapeSnapshotText(labelText) + '"' : ''
        const attrs = ['ref=' + ref]
        for (const [name, value] of Object.entries(state || {})) {
          const formatted = formatSnapshotAttribute(name, value)
          if (formatted) attrs.push(formatted)
        }
        return '- ' + role + label + (attrs.length ? ' [' + attrs.join(', ') + ']' : '')
      }
      const getTargetRef = (node, role, text, attributes) => {
        const existingRef = refByNode.get(node)
        if (existingRef) return existingRef

        const ref = '@e' + nextRefIndex
        nextRefIndex += 1
        refByNode.set(node, ref)
        if (snapshotLines.length < maxSnapshotLines) {
          const state = readSnapshotState(node, attributes)
          snapshotLines.push(formatSnapshotLine(ref, node, role, text, attributes, state))
        }
        return ref
      }
      const buildCssPath = (node) => {
        if (!isElementNode(node)) return null
        const id = node.getAttribute('id')
        if (id) return '#' + escapeCss(id)
        for (const attr of ['data-testid', 'data-test', 'data-qa']) {
          const value = node.getAttribute(attr)
          if (value) return node.tagName.toLowerCase() + '[' + attr + '="' + value.replace(/"/g, '\\\\"') + '"]'
        }
        const name = node.getAttribute('name')
        if (name) return node.tagName.toLowerCase() + '[name="' + name.replace(/"/g, '\\\\"') + '"]'
        const ariaLabel = node.getAttribute('aria-label')
        if (ariaLabel) return node.tagName.toLowerCase() + '[aria-label="' + ariaLabel.replace(/"/g, '\\\\"') + '"]'
        const href = isHtmlAnchorElement(node) ? node.getAttribute('href') : null
        if (href) return 'a[href="' + href.replace(/"/g, '\\\\"') + '"]'

        const parts = []
        let current = node
        while (current && isElementNode(current) && parts.length < 4) {
          const parent = current.parentElement
          const tagName = current.tagName.toLowerCase()
          if (!parent) {
            parts.unshift(tagName)
            break
          }
          const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName)
          const index = siblings.indexOf(current) + 1
          parts.unshift(siblings.length > 1 ? tagName + ':nth-of-type(' + index + ')' : tagName)
          current = parent
        }
        return parts.join(' > ') || null
      }
      const buildTarget = (node, role, text, frame = null) => {
        if (!isElementNode(node)) return null
        const attributes = {}
        // A3: 补充 placeholder / title / aria-label，让模型精准定位表单字段和按钮
        for (const attr of ['id', 'name', 'type', 'accept', 'multiple', 'href', 'aria-label', 'aria-labelledby', 'placeholder', 'title', 'data-testid', 'data-test', 'data-qa']) {
          const value = node.getAttribute(attr)
          if (value) attributes[attr] = value
        }
        const ref = getTargetRef(node, role, text, attributes)
        return {
          ref,
          css: buildCssPath(node),
          role,
          text: text || null,
          name: node.getAttribute('name') || null,
          frame: frame || undefined,
          attributes,
        }
      }
      const buildFrameTarget = (iframe) => {
        if (!isHtmlIFrameElement(iframe)) return null
        const name = normalize(iframe.getAttribute('name'))
        const title = normalize(iframe.getAttribute('title') || iframe.getAttribute('aria-label'))
        let url = null
        try {
          url = iframe.contentWindow?.location?.href || iframe.src || null
        } catch {
          url = iframe.src || null
        }
        return {
          css: buildCssPath(iframe),
          name: name || null,
          title: title || null,
          url: url || null,
        }
      }
      const inferFormFieldRole = (node) => {
        const tagName = node.tagName.toLowerCase()
        if (tagName === 'select') return 'combobox'
        if (isHtmlInputElement(node)) {
          const type = normalize(node.type).toLowerCase()
          if (type === 'checkbox') return 'checkbox'
          if (type === 'radio') return 'radio'
        }
        return 'textbox'
      }
      const readAriaLabelledByText = (node) => {
        if (!isElementNode(node)) return ''
        const ownerDocument = node.ownerDocument || document
        return normalize(node.getAttribute('aria-labelledby'))
          .split(/\\s+/)
          .map((id) => normalize(ownerDocument.getElementById(id)?.textContent))
          .filter(Boolean)
          .join(' ')
      }
      const readFieldLabelText = (element) => {
        if (!isElementNode(element)) return ''
        const ownerDocument = element.ownerDocument || document
        const fieldId = element.getAttribute('id')
        const explicitLabel = fieldId
          ? normalize(ownerDocument.querySelector('label[for="' + escapeCss(fieldId) + '"]')?.textContent)
          : ''
        const wrappingLabel = normalize(element.closest('label')?.textContent)
        const labelledBy = readAriaLabelledByText(element)
        const ariaLabel = normalize(element.getAttribute('aria-label'))
        const title = normalize(element.getAttribute('title'))
        return explicitLabel || wrappingLabel || labelledBy || ariaLabel || title
      }
      const checkableSelector = 'input[type="checkbox"], input[type="radio"]'
      const resolveCheckableControl = (node) => {
        if (isHtmlInputElement(node) && ['checkbox', 'radio'].includes(normalize(node.type).toLowerCase())) return node
        if (!isHtmlLabelElement(node)) return null
        const label = node
        if (isHtmlInputElement(label.control) && ['checkbox', 'radio'].includes(normalize(label.control.type).toLowerCase())) return label.control
        const nested = label.querySelector(checkableSelector)
        return isHtmlInputElement(nested) ? nested : null
      }
      const buildCheckableLabelTarget = (label, control, text, frame = null) => {
        const target = buildTarget(label, normalize(control.type).toLowerCase(), text, frame)
        if (!target) return null

        target.name = control.getAttribute('name') || target.name
        target.attributes.type = normalize(control.type).toLowerCase()
        target.attributes.name = control.getAttribute('name') || ''
        target.attributes.checked = String(control.checked)
        if (control.id) target.attributes.controlId = control.id
        return target
      }
      const buildCheckableLabelField = (label, frame = null) => {
        if (!isHtmlLabelElement(label) || !isVisible(label)) return null
        const control = resolveCheckableControl(label)
        if (!control || control.disabled || isVisible(control)) return null
        const type = normalize(control.type).toLowerCase()
        const labelText = readFieldLabelText(control) || normalize(label.textContent || control.getAttribute('aria-label') || control.getAttribute('title'))
        const name = normalize(control.getAttribute('name'))
        const targetText = labelText || name || type
        return {
          label: targetText,
          type,
          name: name || null,
          placeholder: null,
          required: control.hasAttribute('required') || control.getAttribute('aria-required') === 'true',
          target: buildCheckableLabelTarget(label, control, targetText, frame),
        }
      }
      const textResult = truncate(document.body?.innerText || '', ${args.maxTextChars})
      const htmlResult = truncate(document.documentElement?.outerHTML || '', ${args.maxHtmlChars})
      const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'))
        .filter((node) => !isIgnoredNode(node))
        .slice(0, 40)
        .map((node) => ({
          level: Number(node.tagName.slice(1)),
          text: normalize(node.textContent),
        }))
        .filter((entry) => entry.text)
      const links = Array.from(document.querySelectorAll('a[href]'))
        .filter((node) => !isIgnoredNode(node))
        .slice(0, 80)
        .map((node) => {
          const text = normalize(node.textContent || node.getAttribute('aria-label') || node.getAttribute('title'))
          return {
            text,
            href: node.href,
            target: buildTarget(node, 'link', text),
          }
        })
        .filter((entry) => entry.href)
      // A2: 可见性检测 — 过滤 display:none / visibility:hidden / disabled 元素
      const isVisible = (el) => {
        if (!isElementNode(el)) return false
        if (el.hasAttribute('disabled')) return false
        const view = el.ownerDocument?.defaultView || window
        const style = view.getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
        // offsetParent 为 null 说明元素或其父元素被隐藏（position:fixed 例外，单独保留）
        if (el.offsetParent === null && style.position !== 'fixed') return false
        return true
      }
      // A1: 权重排序 — 核心交互元素优先，减少无关 a 标签占用 maxElements 配额
      const ACTION_WEIGHT = { button: 10, submit: 10, option: 9, menuitem: 9, reset: 8, input: 7, select: 7, combobox: 7, textarea: 6, link: 2 }
      const ACTION_SELECTOR = 'button, input[type="button"], input[type="submit"], input[type="reset"], [role="button"], [role="combobox"], [role="option"], [role="menuitem"], [aria-haspopup="listbox"], [aria-haspopup="menu"], a[href]'
      const collectActionCandidates = (root, frame = null) => Array.from(root.querySelectorAll(ACTION_SELECTOR))
        .filter((node) => !isIgnoredNode(node))
        .filter(isVisible)
        .map((node) => {
          const tagName = node.tagName.toLowerCase()
          const inputType = isHtmlInputElement(node) ? normalize(node.type) : ''
          const explicitRole = normalize(node.getAttribute('role')).toLowerCase()
          const hasDropdownPopup = ['listbox', 'menu'].includes(normalize(node.getAttribute('aria-haspopup')).toLowerCase())
          let role = 'button'
          if (explicitRole === 'option') role = 'option'
          else if (explicitRole === 'menuitem') role = 'menuitem'
          else if (tagName === 'a') role = 'link'
          else if (inputType === 'submit') role = 'submit'
          else if (inputType === 'reset') role = 'reset'
          else if (explicitRole === 'combobox' || hasDropdownPopup) role = 'combobox'
          const text = normalize(
            node.textContent
            || node.getAttribute('aria-label')
            || node.getAttribute('title')
            || (isHtmlInputElement(node) ? node.value : '')
          )
          return {
            text,
            role,
            _weight: ACTION_WEIGHT[role] ?? 2,
            target: buildTarget(node, role, text, frame),
          }
        })
        .filter((entry) => entry.text)
      const readSameOriginFrameDocument = (iframe) => {
        try {
          return iframe.contentDocument
        } catch {
          return null
        }
      }
      const collectSameOriginFrameActions = () => {
        const actions = []
        for (const iframe of Array.from(document.querySelectorAll('iframe'))) {
          if (!isVisible(iframe)) continue
          const frame = buildFrameTarget(iframe)
          const frameDocument = readSameOriginFrameDocument(iframe)
          if (!frame?.css || !frameDocument?.documentElement) continue
          actions.push(...collectActionCandidates(frameDocument, frame))
        }
        return actions
      }
      const actionNodes = [
        ...collectActionCandidates(document),
        ...collectSameOriginFrameActions(),
      ]
        .sort((a, b) => b._weight - a._weight)
        .slice(0, ${args.maxElements})
        .map(({ _weight: _w, ...entry }) => entry)
      // A2: formFields 同样过滤不可见/禁用元素，避免隐藏字段干扰模型理解
      const collectVisibleFormFields = (root, frame = null) => Array.from(root.querySelectorAll('input, textarea, select'))
        .filter((node) => !isIgnoredNode(node))
        .filter((node) => {
          const t = (isHtmlInputElement(node) ? node.type : '').toLowerCase()
          // hidden type 字段保留（有些表单依赖 hidden 字段传值），但 display:none 的不要
          if (t === 'hidden') return false
          return isVisible(node)
        })
        .slice(0, 60)
        .map((node) => {
          const element = node
          const labelText = readFieldLabelText(element)
          const placeholder = normalize(element.getAttribute('placeholder'))
          const name = normalize(element.getAttribute('name'))
          const type = normalize(element.getAttribute('type') || node.tagName.toLowerCase())
          return {
            label: labelText || placeholder || name || type,
            type: type || 'field',
            name: name || null,
            placeholder: placeholder || null,
            required: element.hasAttribute('required') || element.getAttribute('aria-required') === 'true',
            target: buildTarget(element, inferFormFieldRole(element), labelText || placeholder || name || type, frame),
          }
        })
        .filter((entry) => entry.label)
      const collectHiddenCheckableLabelFields = (root, frame = null) => Array.from(root.querySelectorAll('label'))
        .filter((node) => !isIgnoredNode(node))
        .map((label) => buildCheckableLabelField(label, frame))
        .filter((entry) => entry && entry.label && entry.target)
      const collectSameOriginFrameFormFields = () => {
        const fields = []
        for (const iframe of Array.from(document.querySelectorAll('iframe'))) {
          if (!isVisible(iframe)) continue
          const frame = buildFrameTarget(iframe)
          const frameDocument = readSameOriginFrameDocument(iframe)
          if (!frame?.css || !frameDocument?.documentElement) continue
          fields.push(...collectVisibleFormFields(frameDocument, frame))
          fields.push(...collectHiddenCheckableLabelFields(frameDocument, frame))
        }
        return fields
      }
      const visibleFormFields = collectVisibleFormFields(document)
      const hiddenCheckableLabelFields = collectHiddenCheckableLabelFields(document)
      const formFields = [
        ...visibleFormFields,
        ...hiddenCheckableLabelFields,
        ...collectSameOriginFrameFormFields(),
      ].slice(0, 60)
      const metaDescription = document.querySelector('meta[name="description"]')?.getAttribute('content') || null
      const capturedAt = Date.now()
      return {
        url: location.href,
        title: document.title || '',
        metaDescription,
        text: textResult.value,
        textTruncated: textResult.truncated,
        ${args.includeHtml ? 'html: htmlResult.value, htmlTruncated: htmlResult.truncated,' : ''}
        headings,
        links,
        actions: actionNodes,
        formFields,
        snapshot: {
          mode: 'compact',
          source: 'dom-inspection',
          lines: snapshotLines,
          refCount: nextRefIndex - 1,
          truncated: nextRefIndex - 1 > snapshotLines.length,
        },
        login: detectLogin(),
        capturedAt,
      }
    })()`
  }
}

export { BrowserInspectionScriptBuilder }
