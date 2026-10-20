/**
 * 模拟宿主 readPluginMeta 的解析：确认 exports 映射能让宿主读到
 * locale/en.json、locale/zh.json 与 icon.svg（否则插件列表里会退化成裸包名）。
 *
 * 用法：node .tools/verify-meta.mjs
 */
import { readFileSync, existsSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

const packageRoot = dirname(fileURLToPath(import.meta.url)).replace(/[\\/]\.tools$/, '')
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))

/**
 * 按 Node 的 exports 规则解析一个 `<pkg>/<subpath>` 资源。
 * @param {string} subpath 子路径（如 'icon'、'locale/en.json'）
 * @returns {string | undefined} 解析出的绝对路径
 */
function resolveExport(subpath) {
  const exportsMap = manifest.exports
  if (typeof exportsMap === 'string') return subpath === '.' ? join(packageRoot, exportsMap) : undefined
  const key = `./${subpath}`
  if (exportsMap[key] !== undefined) return join(packageRoot, exportsMap[key])
  // 通配模式 ./locale/*.json
  for (const [pattern, target] of Object.entries(exportsMap)) {
    if (!pattern.includes('*')) continue
    const [prefix, suffix] = pattern.split('*')
    if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue
    const middle = key.slice(prefix.length, key.length - suffix.length)
    return join(packageRoot, String(target).replace('*', middle))
  }
  return undefined
}

console.log('[meta] 资源解析')
const englishPath = resolveExport('locale/en.json')
check(englishPath !== undefined && existsSync(englishPath), 'locale/en.json 可解析且存在')
const chinesePath = resolveExport('locale/zh.json')
check(chinesePath !== undefined && existsSync(chinesePath), 'locale/zh.json 可解析且存在')

const english = englishPath === undefined ? {} : JSON.parse(readFileSync(englishPath, 'utf8'))
const chinese = chinesePath === undefined ? {} : JSON.parse(readFileSync(chinesePath, 'utf8'))
check(typeof english.meta?.title === 'string' && english.meta.title.length > 0, '英文 title 非空')
check(typeof english.meta?.description === 'string' && english.meta.description.length > 0, '英文 description 非空')
check(typeof chinese.meta?.title === 'string' && chinese.meta.title.length > 0, '中文 title 非空')
check(typeof chinese.meta?.description === 'string' && chinese.meta.description.length > 0, '中文 description 非空')
check(english.meta.title !== manifest.name, 'title 不是裸包名（不会退化成默认展示）')

console.log('\n[meta] 图标')
const iconPath = resolveExport('icon')
check(iconPath !== undefined && existsSync(iconPath), './icon 可解析且存在')
if (iconPath !== undefined && existsSync(iconPath)) {
  const bytes = readFileSync(iconPath)
  check(bytes.length <= 256 * 1024, `图标小于 256 KiB（${bytes.length} 字节）`)
  const text = bytes.toString('utf8')
  check(text.trimStart().startsWith('<svg'), '图标是 SVG')
  check(text.includes('</svg>'), 'SVG 闭合完整')
  // 宿主读取后会 realpath 校验必须留在包目录内
  const real = realpathSync(iconPath)
  const rootReal = realpathSync(packageRoot)
  check(real.startsWith(rootReal), '图标 realpath 仍在包目录内')
  // viewBox 必须存在，否则不同尺寸下会裁切
  check(/viewBox="[\d\s.]+"/.test(text), 'SVG 声明了 viewBox')
  check(!/<script|onload=/i.test(text), 'SVG 不含脚本')
}

console.log('\n[meta] 包本身')
check(manifest.name === 'dsh-plugin-backup', '包名固定（改名会让已存快照指向失效）')
check(manifest.dsh?.bundle?.patch === './cordis.patch.yml', '声明了 bundle patch')
check(manifest.dsh?.client?.platform === 'web', '声明了 web 客户端半侧')
check(resolveExport('client') !== undefined, './client 导出存在（浏览器半侧可被加载）')
// bundle patch 由宿主按包目录直接读取（不经 exports 映射）
check(existsSync(join(packageRoot, manifest.dsh.bundle.patch)), 'patch 文件存在')

const patch = readFileSync(join(packageRoot, 'cordis.patch.yml'), 'utf8')
check(/id:\s*plugin-backup/.test(patch), 'patch 里的行 id 是 plugin-backup')
check(/name:\s*'dsh-plugin-backup'/.test(patch), 'patch 里的模块名与包名一致')

console.log('\n[meta] files 白名单覆盖全部运行文件')
for (const required of ['index.js', 'client.js', 'cordis.patch.yml', 'locale/*.json', 'icon.svg']) {
  check(manifest.files.includes(required), `files 含 ${required}`)
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} 项)`}`)
process.exit(failures === 0 ? 0 : 1)
