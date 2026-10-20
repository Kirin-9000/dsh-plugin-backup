/**
 * 真实文件系统上的端到端验证，覆盖本轮新增的两个能力：
 *   1. 把备份目录指到 .dsh 之外，备份真的落在那里；
 *   2. 指定一份外部 JSON 清单，直接按它恢复。
 *
 * 用模拟的 pluginManager（不真的装包），但**用真实的磁盘读写**。
 *
 * 用法：node .tools/verify-external.mjs
 */
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

// 模拟的 "C:\Users\x\.dsh" 与一个完全独立的"备份盘"
const fakeHome = mkdtempSync(join(tmpdir(), 'fake-dsh-home-'))
const externalRoot = mkdtempSync(join(tmpdir(), 'external-backup-'))
const fakeUserHome = mkdtempSync(join(tmpdir(), 'fake-user-home-'))
process.env.DSH_HOME = fakeHome
process.env.DSH_PROFILE = 'desktop'
// 位置镜像必须重定向到临时目录，绝不能写进真实用户主目录
process.env.DSH_PLUGIN_BACKUP_MIRROR = join(fakeUserHome, '.dsh-plugin-backup-location.json')
delete process.env.DSH_PLUGIN_BACKUP_DIR

const { apply } = await import('../index.js')

const installed = new Map([
  ['dsh-better-sidebar', { version: '0.28.0', source: 'dsh-better-sidebar@^0.28.0' }],
  ['dsh-pet', { version: '0.3.7', source: 'dsh-pet@^0.3.7' }],
])
const installCalls = []

const manager = {
  async listBundles() {
    return [...installed.entries()].map(([name, info]) => ({
      name,
      official: false,
      availability: 'profile',
      version: info.version,
      enabled: true,
      installed: true,
      optional: false,
      removable: true,
      source: info.source,
      rows: [{ rowId: name, moduleName: name, entryId: `include:${name}` }],
      overrides: [],
    }))
  },
  async listPlugins() {
    return [...installed.keys()].map((name) => ({ entryId: `include:${name}`, moduleName: name, enabled: true }))
  },
  async installBundle(spec) {
    installCalls.push(spec)
    return { application: 'applied' }
  },
  async removeBundle() {
    return { application: 'applied' }
  },
  async setBundleEnabled() {
    return { application: 'applied' }
  },
  async setPluginEnabled() {
    return { application: 'applied' }
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

/**
 * 调一个插件方法。
 * @param {string} method 方法
 * @param {object} [payload] 请求体
 * @returns {Promise<object>} 响应体
 */
async function call(method, payload = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const req = {
    method: 'POST',
    url: `/plugin-backup/api/${method}`,
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
  return JSON.parse(text)
}

// ── 1. 初始状态：默认目录在 .dsh 里 ───────────────────────────────────────

console.log('[1] 初始位置在 .dsh 里（有被重置的风险）')
const initial = await call('status')
check(initial.location.isDefault === true, '初始是默认目录')
check(initial.location.backupDir.startsWith(fakeHome), '默认目录在 $DSH_HOME 下')
check(
  initial.location.backupDir.startsWith(fakeHome),
  '这正是用户担心的情况：清 .dsh 会把它一起带走',
)

// ── 2. 改到 .dsh 之外 ─────────────────────────────────────────────────────

console.log('\n[2] 把备份目录改到 .dsh 之外')
const moved = await call('settings', { backupDir: externalRoot })
check(moved.ok === true, '位置保存成功')
check(moved.location.backupDir === externalRoot, '生效目录是外部目录')
check(!moved.location.backupDir.startsWith(fakeHome), '新目录确实不在 $DSH_HOME 内')
check(moved.location.source === 'settings', '来源标为自定义')

const backedUp = await call('backup')
check(backedUp.ok === true, '在新位置备份成功')
check(backedUp.file.startsWith(externalRoot), '快照写进外部目录')
check(existsSync(join(externalRoot, 'latest.json')), '外部目录里有 latest.json')

// ── 3. 模拟 DSH 升级：整个 .dsh 被重置 ───────────────────────────────────

console.log('\n[3] 模拟升级把 .dsh 整个清掉')
const mirrorPath = process.env.DSH_PLUGIN_BACKUP_MIRROR
rmSync(fakeHome, { recursive: true, force: true })
mkdirSync(fakeHome, { recursive: true })
check(existsSync(join(externalRoot, 'latest.json')), '外部目录的备份在 .dsh 被清后仍然存在')
check(existsSync(mirrorPath), '位置指针的主目录镜像也活着（.dsh 重置带不走它）')

const afterReset = await call('status')
check(afterReset.ok === true, '.dsh 被清后 status 仍然可用')
check(afterReset.snapshot !== undefined, '仍然读得到备份清单')
check(afterReset.backedUp.length === 2, '清单内容完好（2 个插件）')
check(afterReset.location.source === 'mirror', '位置来源标为 mirror（靠镜像找回来的）')
check(afterReset.location.restoredFromMirror === true, '界面能据此提示"请重新保存一次位置"')
check(afterReset.location.backupDir === externalRoot, '找回来的仍是用户之前指定的外部目录')

// .dsh 里的正式记录确实没了
check(!existsSync(join(fakeHome, 'plugin-backup', 'settings.json')), '.dsh 里的正式记录随重置消失（镜像兜住了）')

// ── 4. 用环境变量把位置钉死（指针丢失也不怕） ─────────────────────────────

console.log('\n[4] 环境变量可把位置直接钉死')
process.env.DSH_PLUGIN_BACKUP_DIR = externalRoot
const viaEnv = await call('status')
check(viaEnv.location.source === 'env', '环境变量优先级最高')
check(viaEnv.location.backupDir === externalRoot, '环境变量指定的目录生效')
check(viaEnv.backedUp.length === 2, '仍能读到外部清单')
delete process.env.DSH_PLUGIN_BACKUP_DIR

// ── 5. 指定任意 JSON 文件恢复 ─────────────────────────────────────────────

console.log('\n[5] 指定一份外部 JSON 清单直接恢复')
// 模拟"用户把清单放在移动硬盘/网盘里"
const handCarried = join(externalRoot, 'from-usb-stick.json')
writeFileSync(
  handCarried,
  JSON.stringify(
    [
      { name: 'dshmarket', version: '1.66.35', source: 'dshmarket@^1.66.35' },
      { name: 'dsh-plugin-wallpaper-engine', version: '1.3.3', source: 'dsh-plugin-wallpaper-engine@^1.3.3' },
    ],
    null,
    2,
  ),
  'utf8',
)

// 当前这两个都没装 → 全部 missing
const preview = await call('load-file', { file: handCarried })
check(preview.ok === true, '读到这份手工清单')
check(preview.bundles.length === 2, '清单里有 2 个插件')
check(preview.diff.every((item) => item.kind === 'missing'), '两个都被识别为未安装')

installCalls.length = 0
const restored = await call('restore', { sourceFile: handCarried })
check(restored.ok === true, '按指定文件发起恢复')
check(restored.accepted === 2, '恢复计划 2 项')
for (let index = 0; index < 80; index += 1) {
  const polled = await call('status')
  if (polled.job !== undefined && polled.job.running !== true) break
  await new Promise((resolve) => setTimeout(resolve, 50))
}
check(installCalls.includes('dshmarket@1.66.35'), '按清单里的版本安装 dshmarket')
check(
  installCalls.includes('dsh-plugin-wallpaper-engine@1.3.3'),
  '按清单里的版本安装 wallpaper-engine',
)

// 这份文件是"纯数组"的最小格式，也应被接受 —— 用户手写清单的最自然写法
check(JSON.parse(readFileSync(handCarried, 'utf8')) instanceof Array, '用例本身用的是纯数组格式')

// ── 6. 指定文件与当前位置互不干扰 ─────────────────────────────────────────

console.log('\n[6] 指定文件不改变备份位置')
const locationNow = await call('settings', {})
check(locationNow.location.backupDir === externalRoot, '读完外部文件后位置没变')
const statusDefault = await call('status')
check(statusDefault.snapshotOrigin === 'latest', '默认 status 用的是备份目录里的清单')
check(statusDefault.backedUp.length === 2, '默认清单仍是之前备份的那 2 个')

rmSync(externalRoot, { recursive: true, force: true })
rmSync(fakeHome, { recursive: true, force: true })
rmSync(fakeUserHome, { recursive: true, force: true })

// 最后确认：真实的用户主目录没有被测试污染
check(
  !existsSync(join(process.env.USERPROFILE ?? '', '.dsh-plugin-backup-location.json')) ||
    (process.env.DSH_PLUGIN_BACKUP_MIRROR ?? '').startsWith(fakeUserHome) === false,
  '测试没有往真实用户主目录写指针文件',
)

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} 项)`}`)
process.exit(failures === 0 ? 0 : 1)
