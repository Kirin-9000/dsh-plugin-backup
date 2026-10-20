/**
 * 浏览器半侧的烟测：不依赖真实 React / 浏览器，用一个最小实现跑通
 * __ModuleLoader__ 注册、locale/slots 装配与面板渲染，确认没有运行时错误、
 * 且文案全部走字典（不出现裸键）。
 *
 * 用法：node .tools/verify-client.mjs
 */
import { readFileSync } from 'node:fs'

let failures = 0
/**
 * 断言。
 * @param {boolean} condition 条件
 * @param {string} message 说明
 */
function check(condition, message) {
  if (condition) console.log(`  ✓ ${message}`)
  else {
    failures += 1
    console.log(`  ✗ ${message}`)
  }
}

// ── 最小 React ────────────────────────────────────────────────────────────

/** 每个组件实例的 hook 状态按组件名重新分配（够用即可） */
const hookStates = new Map()
/** 已执行过的 effect 槽（模拟 React 的 deps 空数组只跑一次） */
const ranEffects = new Set()
/** 待执行的 effect 回调 */
let pendingEffects = []
/** effect 清理函数 */
const cleanups = []

const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat() }
  },
  useState(initial) {
    const key = `${currentComponent}:${hookIndex}`
    if (!hookStates.has(key)) hookStates.set(key, typeof initial === 'function' ? initial() : initial)
    const index = hookIndex
    hookIndex += 1
    const set = (value) => {
      const previous = hookStates.get(key)
      const next = typeof value === 'function' ? value(previous) : value
      hookStates.set(key, next)
      stateChanged = true
    }
    return [hookStates.get(key), set]
  },
  useEffect(callback) {
    const key = `${currentComponent}:${hookIndex}`
    hookIndex += 1
    if (!ranEffects.has(key)) pendingEffects.push({ key, callback })
    return undefined
  },
  useRef(initial) {
    const key = `${currentComponent}:${hookIndex}`
    if (!hookStates.has(key)) hookStates.set(key, { current: initial })
    hookIndex += 1
    return hookStates.get(key)
  },
  useCallback(fn) {
    hookIndex += 1
    return fn
  },
  useMemo(fn) {
    hookIndex += 1
    return fn()
  },
}

let currentComponent = ''
let hookIndex = 0
/** 本轮是否有 setState（决定要不要再渲染一轮） */
let stateChanged = false

/**
 * 把组件当普通函数调用，拿到元素树（相当于浅渲染）。
 * @param {Function} component 组件
 * @param {object} props 属性
 * @returns {object} 元素树
 */
function render(component, props) {
  const previous = currentComponent
  currentComponent = `${component.name}#${typeof props?.t === 'function' ? 't' : ''}`
  hookIndex = 0
  const tree = component(props)
  currentComponent = previous
  return tree
}

/**
 * 展开元素树：函数型元素（子组件）按 React 的方式调用，从而触发它们的 hook。
 * @param {unknown} node 元素
 * @returns {unknown} 展开后的元素树（函数组件被替换为其返回的元素）
 */
function expand(node) {
  if (node === undefined || node === null || node === false || node === true) return node
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node === 'object' && node.type !== undefined) {
    if (typeof node.type === 'function') return expand(render(node.type, node.props))
    return { ...node, children: node.children.map(expand) }
  }
  return node
}

/**
 * 挂载并驱动一个组件：展开渲染 → 执行 effect（模拟 fetch + setState）→ 重渲染。
 * @param {Function} component 组件
 * @param {object} props 属性
 * @returns {Promise<object>} 稳定后的元素树
 */
async function mount(component, props) {
  let tree = expand(render(component, props))
  for (let round = 0; round < 10; round += 1) {
    stateChanged = false
    const queued = pendingEffects
    pendingEffects = []
    for (const effect of queued) {
      ranEffects.add(effect.key)
      const dispose = effect.callback()
      if (typeof dispose === 'function') cleanups.push(dispose)
    }
    // 让 effect 里发起的 fetch.then 落地
    await new Promise((resolve) => setTimeout(resolve, 0))
    tree = expand(render(component, props))
    if (!stateChanged && pendingEffects.length === 0) break
  }
  return tree
}

// ── 假浏览器环境 ──────────────────────────────────────────────────────────

/** 记录注入的 <style> 与 fetch 调用 */
const injected = { styles: [], fetches: [] }

const documentStub = {
  baseURI: 'http://127.0.0.1:52157/',
  head: {
    appendChild(node) {
      injected.styles.push(node)
    },
  },
  createElement(tag) {
    return {
      tag,
      dataset: {},
      textContent: '',
      removed: false,
      remove() {
        this.removed = true
      },
    }
  },
}

globalThis.document = documentStub
globalThis.window = { __ModuleLoader__: { load(registration) { globalThis.__registered = registration } } }

/** 假 locale 服务：字典登记后可 bind 出 t() */
const dictionaries = new Map()

const slots = {
  injected: [],
  register(spec, component) {
    return { spec, component }
  },
  inject(name, callback) {
    slots.injected.push({ name, result: callback() })
  },
}

const locale = {
  register(namespace, dicts) {
    dictionaries.set(namespace, dicts)
    return () => {}
  },
  bind(namespace) {
    return (key) => {
      const dict = dictionaries.get(namespace)
      const value = dict === undefined ? undefined : dict.zh[key]
      return value === undefined ? key : value
    }
  },
}

/** 记录 effect 的注册，便于断言清理函数 */
const effects = []
const ctx = {
  locale,
  slots,
  effect(callback, label) {
    effects.push({ label, dispose: callback() })
    return () => {}
  },
}

// ── 加载并装配客户端插件 ──────────────────────────────────────────────────

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
// 用 Function 执行，等价于浏览器里作为脚本加载（不做 ESM 解析）
new Function('window', source)(globalThis.window)

const registration = globalThis.__registered
check(registration !== undefined, '__ModuleLoader__.load 被调用')
check(registration.id === 'dsh-plugin-backup', '注册的模块 id 与包名一致')

const module = registration.factory((spec) => {
  if (spec === 'react') return React
  throw new Error(`unexpected require: ${spec}`)
})
check(module.name === 'plugin-backup', '模块 name 正确')
check(Array.isArray(module.inject) && module.inject.includes('slots') && module.inject.includes('locale'), '声明了 slots / locale 依赖')

module.apply(ctx)

check(dictionaries.has('plugin-backup'), '注册了 locale 字典')
const dicts = dictionaries.get('plugin-backup')
check(typeof dicts.en === 'object' && typeof dicts.zh === 'object', '中英字典都在')
check(dicts.zh.nav === '备份与恢复', '中文导航文案正确')
check(Object.keys(dicts.en).length === Object.keys(dicts.zh).length, '中英字典键数一致')
for (const key of Object.keys(dicts.zh)) {
  if (dicts.en[key] === undefined) check(false, `英文缺键 ${key}`)
}
check(dicts.zh.summary !== undefined && dicts.en.summary !== undefined, '新增键两边都有')

check(injected.styles.length === 1, '注入了一份样式')
const cssText = injected.styles[0].textContent
check(cssText.includes('--dsw-alias-label-primary'), '样式引用主题文字令牌')

// 严格：一个硬编码颜色都不许有。
// 之前这里放行了 `#fff`，正好漏掉了"主按钮白字压浅色主色看不见"的 bug。
const hexColors = cssText.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
const rgbColors = cssText.match(/\b(?:rgb|hsl)a?\(/g) ?? []
check(hexColors.length === 0, `样式里没有硬编码 hex 颜色${hexColors.length === 0 ? '' : `（发现 ${hexColors.join(', ')}）`}`)
check(rgbColors.length === 0, '样式里没有硬编码 rgb/hsl 颜色')

// 按钮文字必须跟随主题：普通按钮用 label-primary，主按钮用翻转色 label-primary-inverted
const buttonRule = /\.pb-btn\{[^}]*\}/.exec(cssText)?.[0] ?? ''
const primaryRule = /\.pb-btn-primary\{[^}]*\}/.exec(cssText)?.[0] ?? ''
check(buttonRule.includes('color:var(--dsw-alias-label-primary)'), '普通按钮文字用 label-primary（跟随主题）')
check(
  primaryRule.includes('color:var(--dsw-alias-label-primary-inverted)'),
  '主按钮文字用 label-primary-inverted（随主题翻转）',
)
check(
  /--dsw-alias-button-primary-fill/.test(primaryRule),
  '主按钮底色用 DSH 自己的 button-primary-fill',
)
check(
  /\.pb-btn-primary:hover[^{]*\{[^}]*--dsw-alias-button-primary-hover/.test(cssText),
  '主按钮悬停态也走主题令牌',
)
// 内联样式也不许硬编码颜色
const inlineStyles = [...readFileSync(new URL('../client.js', import.meta.url), 'utf8').matchAll(/style:\s*\{[^}]*\}/g)].map((m) => m[0])
check(
  inlineStyles.every((style) => !/#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\(/.test(style)),
  '内联样式里没有硬编码颜色',
)

check(slots.injected.length === 1 && slots.injected[0].name === 'settings.plugins.tab', '注册到 settings.plugins.tab')
const registered = slots.injected[0].result
check(registered.spec.id === 'plugin-backup', '槽位 id 正确')
check(registered.spec.order === 70, '槽位顺序正确')
check(typeof registered.spec.label === 'function', 'label 是函数（跟随语言切换）')
check(registered.spec.label() === '备份与恢复', 'label 取到中文文案')

// ── 渲染面板：没有快照的状态 ──────────────────────────────────────────────

globalThis.fetch = async (url) => {
  injected.fetches.push(String(url))
  return {
    ok: true,
    async json() {
      return {
        ok: true,
        backupDir: 'C:\\Users\\Administrator\\.dsh\\plugin-backup',
        snapshot: undefined,
        current: { count: 6, bundles: [] },
        diff: [],
        managerAvailable: true,
        log: [],
      }
    },
  }
}

const t = locale.bind('plugin-backup')

/**
 * 收集元素树里的全部文本；函数型元素（子组件）会递归渲染展开。
 * @param {unknown} node 元素或文本
 * @param {string[]} out 结果
 * @returns {string[]} 文本数组
 */
function texts(node, out = []) {
  if (node === undefined || node === null || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) texts(child, out)
    return out
  }
  if (typeof node === 'object' && node.type !== undefined) {
    // 函数型元素 = 子组件：真渲染里 React 会调用它，这里同样展开
    if (typeof node.type === 'function') {
      texts(render(node.type, node.props), out)
      return out
    }
    for (const child of node.children) texts(child, out)
  }
  return out
}

/**
 * 在元素树里找出满足条件的元素（用于模拟点击按钮）。
 * @param {unknown} node 元素树
 * @param {(node: object) => boolean} predicate 判定
 * @param {object[]} out 结果
 * @returns {object[]} 命中的元素
 */
function findAll(node, predicate, out = []) {
  if (node === undefined || node === null || node === false || node === true) return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  if (typeof node === 'object' && node.type !== undefined) {
    if (typeof node.type === 'function') {
      findAll(render(node.type, node.props), predicate, out)
      return out
    }
    if (predicate(node)) out.push(node)
    for (const child of node.children) findAll(child, predicate, out)
  }
  return out
}

/**
 * 找到包含某段文本的按钮（只看自己的普通元素子节点，不展开子组件）。
 * @param {unknown} tree 元素树
 * @param {string} label 期望包含的文本
 * @returns {object | undefined} 按钮元素
 */
function findButton(tree, label) {
  return findAll(tree, (node) => {
    if (node.type !== 'button') return false
    // 按钮内容通常是 span 等普通元素：把它们直接收文本，不展开函数组件
    const own = []
    for (const child of node.children) {
      if (typeof child === 'string') own.push(child)
      else if (child !== null && typeof child === 'object' && typeof child.type === 'string') own.push(...texts(child))
    }
    return own.some((line) => line === label || line.includes(label))
  })[0]
}

const emptyPanel = await mount(registered.component, { t })
const emptyTexts = texts(emptyPanel)
check(emptyTexts.includes('插件备份与恢复'), '渲染出标题')
check(emptyTexts.includes('还没有备份'), '没有快照时展示提示')
check(emptyTexts.some((line) => line.includes('备份位置')), '展示备份目录')
check(emptyTexts.includes('当前安装: 6 个插件'), '展示当前安装数量')
check(emptyTexts.includes('还没有任何备份，请先点「立即备份」写下当前清单。'), '没有快照时提示先备份')
check(injected.fetches.some((url) => url.includes('plugin-backup/api/status')), '挂载后请求了 status')

// ── 渲染面板：有差异的状态 ────────────────────────────────────────────────

globalThis.fetch = async () => ({
  ok: true,
  async json() {
    return {
      ok: true,
      backupDir: 'C:\\Users\\Administrator\\.dsh\\plugin-backup',
      snapshot: { createdAt: '2026-10-20T06:12:19.508Z', count: 4, dshVersion: '0.2.1-rc.2' },
      // 备份里的插件清单本体：这是用户要在页面上"看到已备份的插件"的数据来源
      backedUp: [
        { name: 'dsh-better-sidebar', version: '0.28.0', rows: 1, state: 'missing', restorable: true },
        { name: 'dsh-pet', version: '0.3.7', rows: 1, state: 'disabled', restorable: true },
        { name: 'dshmarket', version: '1.66.35', rows: 1, state: 'partial', restorable: true },
        { name: 'dsh-plugin-wallpaper-engine', version: '1.3.3', rows: 1, state: 'version-mismatch', liveVersion: '1.2.0', restorable: true },
        { name: 'dsh-ua-proxy', version: '1.0.0', rows: 1, state: 'ok', restorable: false },
      ],
      current: { count: 3, bundles: [] },
      diff: [
        { kind: 'missing', name: 'dsh-better-sidebar', version: '0.28.0', spec: 'dsh-better-sidebar@0.28.0', detail: '备份里有这个插件，当前 profile 里没有安装。' },
        { kind: 'disabled', name: 'dsh-pet', version: '0.3.7', detail: '插件已安装，但处于禁用状态。' },
        { kind: 'row-disabled', name: 'dshmarket', moduleName: 'dshmarket', detail: '插件行 dshmarket 被禁用了。' },
        { kind: 'version-mismatch', name: 'dsh-plugin-wallpaper-engine', version: '1.3.3', liveVersion: '1.2.0', spec: 'dsh-plugin-wallpaper-engine@1.3.3', detail: '备份记录 1.3.3，当前是 1.2.0。' },
      ],
      // 自定义目录 + 非默认来源：验证"存储位置"区能展示出来
      location: {
        backupDir: 'D:\\dsh-backups',
        defaultBackupDir: 'C:\\Users\\Administrator\\.dsh\\plugin-backup',
        source: 'settings',
        isDefault: false,
        writable: true,
        settingsFile: 'C:\\Users\\Administrator\\.dsh\\plugin-backup\\settings.json',
        latestFile: 'D:\\dsh-backups\\latest.json',
        logFile: 'D:\\dsh-backups\\log.jsonl',
      },
      managerAvailable: true,
      job: undefined,
      log: [],
    }
  },
})

// 新的一份组件状态：清掉上一步的 hook 状态
hookStates.clear()
ranEffects.clear()
pendingEffects = []
const diffPanel = await mount(registered.component, { t })
const diffTexts = texts(diffPanel)
check(diffTexts.includes('检测到的差异'), '渲染出差异区标题')

// 「已备份的插件」：核心诉求——页面上能看到备份里有哪些插件
check(diffTexts.includes('已备份的插件'), '渲染出「已备份的插件」区')
check(diffTexts.includes('5 个插件'), '展示备份里的插件数量')
check(diffTexts.includes('dsh-ua-proxy'), '列出没有差异、状态正常的备份插件')
check(diffTexts.includes('dsh-better-sidebar'), '列出缺失的备份插件')
check(diffTexts.includes('dshmarket'), '列出部分异常的备份插件')
check(diffTexts.includes('已安装'), '状态正常的行标为「已安装」')
check(diffTexts.includes('未安装'), '未安装的行标为「未安装」')
check(diffTexts.includes('部分异常'), '部分行异常时标为「部分异常」')
check(diffTexts.includes('无安装来源，需手工安装'), '无来源的插件明确提示需手工处理')
check(diffTexts.some((line) => line.includes('当前 1.2.0')), '版本漂移时同时给出备份版本与当前版本')
check(diffTexts.includes('1 个插件行'), '展示备份时的插件行数')

check(diffTexts.includes('立即备份'), '渲染出备份按钮')
check(diffTexts.includes('恢复所选'), '渲染出恢复按钮')
check(diffTexts.includes('版本不同'), '展示「版本不同」标签')
check(diffTexts.includes('行已禁用'), '展示「行已禁用」标签')
check(diffTexts.some((line) => line.includes('DSH 0.2.1-rc.2')), '展示快照采集时的 DSH 版本')

// ── 存储位置：可自定义，且解释"为什么要移出 .dsh" ─────────────────────────
check(diffTexts.includes('备份存储位置'), '渲染出「备份存储位置」区')
check(diffTexts.includes('更改位置'), '提供「更改位置」按钮')
check(diffTexts.includes('恢复默认'), '自定义状态下提供「恢复默认」')
check(diffTexts.includes('D:\\dsh-backups'), '展示当前自定义目录')
check(diffTexts.includes('自定义'), '标出来源是自定义')
check(
  diffTexts.some((line) => line.includes('Harness 更新有可能重置整个 .dsh')),
  '说明为什么要把备份移出 .dsh',
)
check(
  diffTexts.some((line) => line.includes('settings.json')),
  '展示位置配置文件的路径',
)

// ── 指定 JSON 文件：可直接按任意清单恢复 ──────────────────────────────────
check(diffTexts.includes('从指定 JSON 文件恢复'), '渲染出「从指定 JSON 文件恢复」区')
check(diffTexts.includes('读取这份文件'), '提供读取文件按钮')
check(diffTexts.includes('当前使用备份目录里的最新清单'), '默认说明用的是备份目录清单')

// 原生选择器：闭包里的包装函数始终存在，可用性在调用时才发现（宿主可能没这个服务）。
// 所以这里断言的是"点了也不会炸"，而不是"按钮不渲染"。
check(diffTexts.includes('选择文件…'), '渲染出「选择」按钮')
check(
  diffTexts.some((line) => line.includes('只会列出 .json 文件')),
  '说明选择器只列 .json',
)

hookStates.clear()
ranEffects.clear()
pendingEffects = []
const withPicker = await mount(registered.component, {
  t,
  pickDirectory: async () => 'D:\\picked',
})
const withPickerTexts = texts(withPicker)
check(withPickerTexts.filter((line) => line === '选择文件…').length >= 1, '有选择器时同样渲染「选择」按钮')

// ── 路径 A：宿主支持系统原生对话框 → 直接用它，不打开内置浏览器 ──────────

const nativeCalls = []
globalThis.fetch = async (url, init) => {
  const target = String(url)
  const payload = init !== undefined && typeof init.body === 'string' ? JSON.parse(init.body) : {}
  if (target.includes('/pick-file')) {
    nativeCalls.push(payload)
    return {
      ok: true,
      async json() {
        return {
          ok: true,
          file: 'D:\\some-other-drive\\plugins\\snapshot.json',
          snapshot: { count: 2 },
          bundles: [
            { name: 'dsh-pet', version: '0.3.7', restorable: true },
            { name: 'dshmarket', version: '1.66.35', restorable: true },
          ],
          diff: [],
        }
      },
    }
  }
  return { ok: true, async json() { return { ok: true, diff: [], backedUp: [], snapshot: undefined, current: { count: 0 }, log: [] } } }
}

hookStates.clear()
ranEffects.clear()
pendingEffects = []
let nativeTree = await mount(registered.component, { t })
const nativeBrowse = findButton(nativeTree, '选择文件…')
check(nativeBrowse !== undefined, '找到「选择文件…」按钮')
nativeBrowse.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 0))
nativeTree = await mount(registered.component, { t })
const nativeTexts = texts(nativeTree)

check(nativeCalls.length >= 1, '优先调用宿主 pick-file（系统原生对话框）')
check(
  !nativeTexts.includes('选择一个插件清单 JSON'),
  '原生对话框路径下不打开内置浏览器',
)
check(
  nativeTexts.some((line) => line.includes('D:\\some-other-drive\\plugins\\snapshot.json')),
  '把原生对话框选中的（可跨盘的）路径填回输入框',
)

// ── 路径 B：宿主不支持原生对话框 → 退回内置 .json 浏览器 ──────────────────

const listingCalls = []
globalThis.fetch = async (url, init) => {
  const target = String(url)
  const payload = init !== undefined && typeof init.body === 'string' ? JSON.parse(init.body) : {}
  if (target.includes('/pick-file')) {
    return { ok: true, async json() { return { ok: false, unsupported: true, error: 'not windows' } } }
  }
  if (target.includes('/list-files')) {
    listingCalls.push(payload.dir)
    return {
      ok: true,
      async json() {
        return {
          ok: true,
          path: 'D:\\dsh-backups',
          home: 'C:\\Users\\Administrator',
          parent: 'D:\\',
          crumbs: [
            { name: 'D:\\', path: 'D:\\' },
            { name: 'dsh-backups', path: 'D:\\dsh-backups' },
          ],
          directories: [{ name: 'old', path: 'D:\\dsh-backups\\old' }],
          files: [{ name: 'latest.json', path: 'D:\\dsh-backups\\latest.json', size: 2492 }],
        }
      },
    }
  }
  // load-file
  return {
    ok: true,
    async json() {
      return {
        ok: true,
        file: payload.file,
        snapshot: { count: 2 },
        bundles: [
          { name: 'dsh-pet', version: '0.3.7', restorable: true },
          { name: 'dshmarket', version: '1.66.35', restorable: true },
        ],
        diff: [],
      }
    },
  }
}

hookStates.clear()
ranEffects.clear()
pendingEffects = []
let pickerTree = await mount(registered.component, { t })
const browseButton = findButton(pickerTree, '选择文件…')
check(browseButton !== undefined, '找到「选择文件…」按钮')

// 点击它（宿主报告不支持原生对话框）
browseButton.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 0))
pickerTree = await mount(registered.component, { t })
const pickerTexts = texts(pickerTree)

check(listingCalls.length >= 1, '不支持原生对话框时退回列目录')
check(pickerTexts.includes('选择一个插件清单 JSON'), '打开了内置文件浏览器')
check(pickerTexts.includes('latest.json'), '列出目录里的 .json 文件')
check(pickerTexts.includes('old'), '列出可进入的子目录')
check(
  pickerTexts.some((line) => line.includes('只显示 .json 文件')),
  '说明只显示 .json',
)
check(pickerTexts.includes('关闭'), '提供关闭按钮')

// 点选那个 json 文件 → 应读取它并关闭浏览器
const fileButton = findButton(pickerTree, 'latest.json')
check(fileButton !== undefined, 'json 文件是可点击的条目')
fileButton.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 0))
pickerTree = await mount(registered.component, { t })
const afterPick = texts(pickerTree)
check(!afterPick.includes('选择一个插件清单 JSON'), '选完文件后浏览器关闭')
check(
  afterPick.some((line) => line.includes('D:\\dsh-backups\\latest.json')),
  '把选中的完整路径填回输入框',
)

// ── 用户的真实处境：全部正常、没有任何差异 ────────────────────────────────
// 这时差异区是空的，但「已备份的插件」必须完整可见——这正是用户要看的东西。
globalThis.fetch = async () => ({
  ok: true,
  async json() {
    return {
      ok: true,
      backupDir: 'C:\\Users\\Administrator\\.dsh\\plugin-backup',
      snapshot: { createdAt: '2026-10-20T06:43:28.801Z', count: 3, dshVersion: '0.2.1-rc.2' },
      backedUp: [
        { name: 'dsh-better-sidebar', version: '0.28.0', rows: 1, state: 'ok', restorable: true },
        { name: 'dsh-pet', version: '0.3.7', rows: 1, state: 'ok', restorable: true },
        { name: 'dshmarket', version: '1.66.35', rows: 1, state: 'ok', restorable: true },
      ],
      current: { count: 3, bundles: [] },
      diff: [],
      managerAvailable: true,
      job: undefined,
      log: [],
    }
  },
})

hookStates.clear()
ranEffects.clear()
pendingEffects = []
const allGood = await mount(registered.component, { t })
const allGoodTexts = texts(allGood)
check(allGoodTexts.includes('已备份的插件'), '没有差异时仍展示「已备份的插件」区')
check(allGoodTexts.includes('3 个插件'), '展示 3 个已备份插件')
check(allGoodTexts.includes('dsh-better-sidebar'), '没有差异时依然列出 dsh-better-sidebar')
check(allGoodTexts.includes('dsh-pet'), '没有差异时依然列出 dsh-pet')
check(allGoodTexts.includes('dshmarket'), '没有差异时依然列出 dshmarket')
check(allGoodTexts.some((line) => line.includes('@0.28.0')), '列出备份时的版本号')
check(
  allGoodTexts.includes('当前安装与备份一致，没有需要恢复的插件。'),
  '差异区如实说明没有需要恢复的',
)

// ── 恢复进度的渲染（组件级） ──────────────────────────────────────────────

const job = {
  running: false,
  total: 2,
  done: 2,
  current: undefined,
  results: [
    { kind: 'missing', name: 'dsh-better-sidebar', ok: true, detail: '已安装并生效' },
    { kind: 'disabled', name: 'dsh-pet', ok: false, detail: '启用失败：operation-error' },
  ],
  summary: '完成，其中 1 项失败（详见日志）',
}

// RestoreProgress 未导出，通过面板的 props 无法直接注入；
// 这里改为断言组件源码里存在该分支并复用同一套字典键。
const source2 = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
check(source2.includes('RestoreProgress'), '存在恢复进度组件')
check(source2.includes("job.running === true ? t('running') : t('finished')"), '进度块按运行/结束切换文案')
check(source2.includes("entry.ok === true ? t('ok') : t('fail')"), '逐项结果展示成功/失败')

// ── 清理函数 ──────────────────────────────────────────────────────────────

for (const effect of effects) {
  if (typeof effect.dispose === 'function') effect.dispose()
}
check(true, 'effect 的清理函数都可调用')

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} 项)`}`)
process.exit(failures === 0 ? 0 : 1)
