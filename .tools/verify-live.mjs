/**
 * 用**真实**的备份快照 + 真实 profile 状态驱动 Host 半侧的 status 构建逻辑，
 * 确认页面拿到的「已备份的插件」清单与人眼在 latest.json 里看到的一致。
 *
 * 用法：node .tools/verify-live.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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

const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const latestPath = join(home, 'plugin-backup', 'latest.json')
const snapshot = JSON.parse(readFileSync(latestPath, 'utf8'))

// ── 真实快照内容 ──────────────────────────────────────────────────────────

console.log('[live] 真实快照内容')
check(Array.isArray(snapshot.bundles), '快照有 bundles 数组')
check(snapshot.bundles.length > 0, `快照记录了 ${snapshot.bundles.length} 个插件`)

const names = snapshot.bundles.map((bundle) => bundle.name)
console.log(`  记录：${names.join(', ')}`)
check(names.includes('dsh-plugin-backup'), '快照包含本插件自身（升级后能把自己也装回来）')
check(!names.some((name) => name.startsWith('@deepseek-ai/dsh-base')), '不记录 DSH 安装自带的 bundle')

for (const bundle of snapshot.bundles) {
  check(typeof bundle.version === 'string' && bundle.version !== '', `${bundle.name} 有精确版本号`)
}

// 与真实 profile 的对照
const profileManifest = JSON.parse(readFileSync(join(home, 'profiles', 'desktop', 'package.json'), 'utf8'))
const dependencies = Object.keys(profileManifest.dependencies ?? {})
for (const name of names) {
  if (name === 'dsh-ua-proxy') continue // 手工放置的包，不在 dependencies 里
  check(dependencies.includes(name), `${name} 在 profile 依赖里`)
}

// ── 页面要展示的那份清单 ──────────────────────────────────────────────────

console.log('\n[live] status.backedUp 与快照一致')
// 备份必须写到临时目录，绝不能覆盖用户真实快照
const { mkdtempSync, rmSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const sandboxHome = mkdtempSync(join(tmpdir(), 'dsh-backup-live-'))
const sandboxLatest = join(sandboxHome, 'plugin-backup', 'latest.json')
const { mkdirSync, writeFileSync } = await import('node:fs')
mkdirSync(join(sandboxHome, 'plugin-backup', 'snapshots'), { recursive: true })
writeFileSync(sandboxLatest, JSON.stringify(snapshot, null, 2), 'utf8')
process.env.DSH_HOME = sandboxHome
process.env.DSH_PROFILE = 'desktop'
// 位置镜像也必须重定向：否则本脚本的自动备份会把指针写进真实用户主目录
process.env.DSH_PLUGIN_BACKUP_MIRROR = join(sandboxHome, 'location.json')

const { apply } = await import('../index.js')

const manager = {
  async listBundles() {
    // 用真实 profile 的依赖表构造"当前安装"：与快照同名的都算已装，
    // 但故意让 wallpaper-engine 报一个旧版本，验证版本漂移的展示
    return snapshot.bundles
      .filter((bundle) => dependencies.includes(bundle.name) || bundle.name === 'dsh-ua-proxy')
      .map((bundle) => ({
        name: bundle.name,
        official: false,
        availability: 'profile',
        version: bundle.name === 'dsh-plugin-wallpaper-engine' ? '1.2.0' : bundle.version,
        enabled: true,
        installed: true,
        optional: false,
        removable: true,
        source: bundle.source,
        rows: bundle.rows.map((row) => ({ rowId: row.rowId, moduleName: row.moduleName, entryId: row.entryId })),
        overrides: [],
      }))
  },
  async listPlugins() {
    return []
  },
}

let route
const ctx = {
  get(name) {
    if (name === 'pluginManager') return manager
    return undefined
  },
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  webServer: {
    register(spec) {
      route = spec
      return () => {}
    },
  },
  tools: { register: () => () => {} },
}
apply(ctx)

const body = Buffer.from('{}', 'utf8')
const req = {
  method: 'POST',
  url: '/plugin-backup/api/status',
  async *[Symbol.asyncIterator]() {
    yield body
  },
}
let text = ''
await route.handler(req, {
  writeHead() {},
  end(chunk) {
    text = String(chunk)
  },
})
const statusBody = JSON.parse(text)

check(Array.isArray(statusBody.backedUp), 'status 返回 backedUp')
check(
  statusBody.backedUp.length === snapshot.bundles.length,
  `backedUp 条数与快照一致（${statusBody.backedUp.length} / ${snapshot.bundles.length}）`,
)
const sameNames = statusBody.backedUp.map((item) => item.name).join(',') === names.join(',')
check(sameNames, 'backedUp 的插件名与快照完全一致（顺序也一致）')

console.log('  页面会展示：')
for (const item of statusBody.backedUp) {
  console.log(`    ${item.name}@${item.version}  state=${item.state}  restorable=${item.restorable}`)
}

for (const item of statusBody.backedUp) {
  check(typeof item.state === 'string' && item.state !== '', `${item.name} 有明确状态`)
  check(typeof item.restorable === 'boolean', `${item.name} 有明确的"能否自动恢复"标记`)
}

// dsh-ua-proxy 是手工放置的包：必须被标为不可自动恢复
const uaProxy = statusBody.backedUp.find((item) => item.name === 'dsh-ua-proxy')
if (uaProxy !== undefined) {
  check(uaProxy.restorable === false, 'dsh-ua-proxy 标为不可自动恢复（没有安装来源）')
} else {
  check(true, '本次快照里没有 dsh-ua-proxy（跳过该断言）')
}

// 版本漂移必须被看出来
const wallpaper = statusBody.backedUp.find((item) => item.name === 'dsh-plugin-wallpaper-engine')
check(wallpaper !== undefined && wallpaper.state === 'version-mismatch', 'wallpaper-engine 检出状态为版本不同')
check(wallpaper !== undefined && wallpaper.liveVersion === '1.2.0', '同时给出现有版本 1.2.0')

rmSync(sandboxHome, { recursive: true, force: true })

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} 项)`}`)
process.exit(failures === 0 ? 0 : 1)
