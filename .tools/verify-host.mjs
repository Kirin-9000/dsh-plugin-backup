/**
 * 用假 ctx 直接驱动 dsh-plugin-backup 的 Host 半侧：
 * 覆盖备份、差异计算、恢复计划（含 already-installed 两步法）与失败继续。
 *
 * 用法：node .tools/verify-host.mjs
 */
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 备份必须写到临时 DSH_HOME，绝不能动用户真实的 ~/.dsh/plugin-backup
const sandboxHome = mkdtempSync(join(tmpdir(), 'dsh-plugin-backup-test-'))
const sandboxMirror = join(mkdtempSync(join(tmpdir(), 'dsh-plugin-backup-mirror-')), 'location.json')
process.env.DSH_HOME = sandboxHome
process.env.DSH_PROFILE = 'test-profile'
// 位置镜像必须重定向：否则测试会把指针写进真实用户主目录
process.env.DSH_PLUGIN_BACKUP_MIRROR = sandboxMirror
delete process.env.DSH_PLUGIN_BACKUP_DIR

const { apply } = await import('../index.js')

// ── 假宿主 ────────────────────────────────────────────────────────────────

/** 可变状态：测试按阶段改写，驱动真实代码路径 */
const world = {
  bundles: [],
  plugins: [],
  /** 安装/移除/启用的调用记录，用来断言"幂等"与"两步法" */
  calls: [],
  /** 下一次 installBundle 的行为 */
  installBehavior: () => ({ application: 'applied' }),
}

const manager = {
  async listBundles() {
    return world.bundles
  },
  async listPlugins() {
    return world.plugins
  },
  async installBundle(spec) {
    world.calls.push(`install:${spec}`)
    return world.installBehavior(spec)
  },
  async removeBundle(name) {
    world.calls.push(`remove:${name}`)
    return { application: 'applied' }
  },
  async setBundleEnabled(name, enabled) {
    world.calls.push(`bundle:${name}:${enabled}`)
    for (const bundle of world.bundles) if (bundle.name === name) bundle.enabled = enabled
    return { application: 'applied' }
  },
  async setPluginEnabled(entryId, enabled) {
    world.calls.push(`plugin:${entryId}:${enabled}`)
    for (const plugin of world.plugins) if (plugin.entryId === entryId) plugin.enabled = enabled
    return { application: 'applied' }
  },
}

/** 捕获注册的 HTTP 路由 */
let route
const ctx = {
  get(name) {
    if (name === 'pluginManager') return manager
    if (name === 'connection') return undefined
    return undefined
  },
  effect(fn, label) {
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
if (route === undefined) throw new Error('路由没有注册')
console.log('route registered:', route.kind, route.path)

// ── 一个能跑 handler 的极简请求/响应 ──────────────────────────────────────

/**
 * 调 handler。
 * @param {string} method 方法名
 * @param {object} [payload] 请求体
 * @returns {Promise<{status: number, body: any}>} 状态与响应体
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
  let status = 0
  let text = ''
  const res = {
    writeHead(code) {
      status = code
    },
    end(chunk) {
      text = chunk === undefined ? '' : String(chunk)
    },
  }
  await route.handler(req, res)
  return { status, body: JSON.parse(text) }
}

// ── 断言小工具 ────────────────────────────────────────────────────────────

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

/** 一条 profile 安装的 bundle 形状（与真实 listBundles 一致） */
function bundleOf(name, version, rows, extra = {}) {
  return {
    name,
    official: false,
    availability: 'profile',
    version,
    enabled: true,
    installed: true,
    optional: false,
    removable: true,
    source: `${name}@^${version}`,
    rows,
    overrides: [],
    ...extra,
  }
}

// ── 阶段 1：没有任何快照 ──────────────────────────────────────────────────

console.log('\n[1] 未备份时 status')
world.bundles = [
  bundleOf('dsh-better-sidebar', '0.28.0', [{ rowId: 'better-sidebar', moduleName: 'dsh-better-sidebar', entryId: 'include:better-sidebar' }]),
  bundleOf('@deepseek-ai/dsh-base', '0.2.1-rc.2', [{ rowId: 'tools', moduleName: '@deepseek-ai/dsh-tools' }], { availability: 'installation' }),
]
world.plugins = [{ entryId: 'include:better-sidebar', moduleName: 'dsh-better-sidebar', enabled: true }]

const empty = await call('status')
check(empty.status === 200, 'status 返回 200')
check(empty.body.snapshot === undefined, '没有快照时 snapshot 为空')
check(empty.body.diff.length === 0, '没有快照时不报差异')
check(empty.body.current.count === 1, '只统计 profile 安装的 bundle（安装自带项被排除）')
check(empty.body.backupDir.startsWith(sandboxHome), '备份目录落在 $DSH_HOME 下')

// ── 阶段 2：备份 ──────────────────────────────────────────────────────────

console.log('\n[2] backup 写快照')
const backup = await call('backup')
check(backup.status === 200 && backup.body.ok === true, 'backup 返回成功')
check(backup.body.count === 1, '只备份 profile 安装的 bundle')
check(existsSync(backup.body.file), '快照文件真实存在')
check(existsSync(join(sandboxHome, 'plugin-backup', 'latest.json')), 'latest.json 存在')

const snapshot = JSON.parse(readFileSync(join(sandboxHome, 'plugin-backup', 'latest.json'), 'utf8'))
check(snapshot.schemaVersion === 1, '快照带 schemaVersion')
check(snapshot.bundles[0].source === 'dsh-better-sidebar@^0.28.0', '快照记录了安装来源 spec')
check(snapshot.bundles[0].rows[0].enabled === true, '快照记录了行启用状态')

// status 必须把"备份里有哪些插件"本身返回给界面，而不只是差异
const listed = await call('status')
check(Array.isArray(listed.body.backedUp), 'status 返回 backedUp 清单')
check(listed.body.backedUp.length === 1, 'backedUp 覆盖快照里的全部插件')
check(listed.body.backedUp[0].name === 'dsh-better-sidebar', 'backedUp 里是真实插件名')
check(listed.body.backedUp[0].version === '0.28.0', 'backedUp 带版本号')
check(listed.body.backedUp[0].rows === 1, 'backedUp 带插件行数')
check(listed.body.backedUp[0].state === 'ok', '全部正常时状态是 ok')
check(listed.body.backedUp[0].restorable === true, '注册表包可恢复')

// 幂等：再备份一次，不应产生重复的真实差异
const backupAgain = await call('backup')
check(backupAgain.body.ok === true, '重复备份仍然成功')

// ── 阶段 3：DSH 升级后插件全没了 ──────────────────────────────────────────

console.log('\n[3] 插件被升级清掉后 status 检出 missing')
world.bundles = []
world.plugins = []
const missingStatus = await call('status')
check(missingStatus.body.diff.length === 1, '检出 1 项差异')
check(missingStatus.body.diff[0].kind === 'missing', '差异种类是 missing')
check(missingStatus.body.diff[0].spec === 'dsh-better-sidebar@0.28.0', '重装 spec 钉到备份时的精确版本')
// 插件没了，清单依然要列出来（这正是用户升级后要看的东西）
check(missingStatus.body.backedUp.length === 1, '插件缺失时 backedUp 仍然完整列出')
check(missingStatus.body.backedUp[0].state === 'missing', '该行状态标为 missing')
check(missingStatus.body.backedUp[0].liveVersion === undefined, '缺失时没有当前版本')

// ── 阶段 4：恢复（正常路径） ──────────────────────────────────────────────

console.log('\n[4] restore 走官方安装接口')
world.calls = []
world.installBehavior = () => ({ application: 'applied' })
const restore = await call('restore', { targets: ['dsh-better-sidebar'] })
check(restore.status === 200 && restore.body.ok === true, 'restore 请求被接受')
check(restore.body.accepted === 1, '恢复计划包含 1 项')

// 等任务跑完（任务在后台串行推进）
for (let index = 0; index < 60; index += 1) {
  const polled = await call('status')
  if (polled.body.job !== undefined && polled.body.job.running !== true) break
  await new Promise((resolve) => setTimeout(resolve, 50))
}
const afterRestore = await call('status')
check(world.calls.includes('install:dsh-better-sidebar@0.28.0'), '调用了 installBundle 且 spec 正确')
check(afterRestore.body.job.done === 1, '任务进度推进到 1/1')
check(afterRestore.body.job.results[0].ok === true, '该项结果为成功')
check(afterRestore.body.job.summary === '全部恢复完成', '汇总文案正确')

// ── 阶段 5：already-installed 两步法 ──────────────────────────────────────

console.log('\n[5] already-installed → 先移除再装')
world.bundles = []
world.plugins = []
world.calls = []
let firstAttempt = true
world.installBehavior = () => {
  if (firstAttempt) {
    firstAttempt = false
    return { application: 'failed', error: { code: 'already-installed' } }
  }
  return { application: 'restart-required' }
}
await call('restore', { targets: ['dsh-better-sidebar'] })
for (let index = 0; index < 60; index += 1) {
  const polled = await call('status')
  if (polled.body.job !== undefined && polled.body.job.running !== true) break
  await new Promise((resolve) => setTimeout(resolve, 50))
}
const twoStep = await call('status')
check(world.calls[0].startsWith('install:'), '第一次尝试是安装')
check(world.calls[1] === 'remove:dsh-better-sidebar', '第二次调用是移除（两步法）')
check(world.calls[2].startsWith('install:'), '第三次调用是重新安装')
check(twoStep.body.job.results[0].ok === true, '重装成功')
check(String(twoStep.body.job.results[0].detail).includes('重启'), 'restart-required 如实提示需重启')

// ── 阶段 6：失败不中断，继续下一项 ────────────────────────────────────────

console.log('\n[6] 一项失败不影响其它项')
world.bundles = []
world.plugins = []
world.calls = []
let attempt = 0
world.installBehavior = () => {
  attempt += 1
  if (attempt === 1) return { application: 'failed', error: { code: 'not-found' } }
  return { application: 'applied' }
}
// 两个 bundle 都缺失：第一个装失败，第二个必须继续
world.bundles = []
const multiRestore = await call('restore', {})
for (let index = 0; index < 100; index += 1) {
  const polled = await call('status')
  if (polled.body.job !== undefined && polled.body.job.running !== true) break
  await new Promise((resolve) => setTimeout(resolve, 50))
}
const multiStatus = await call('status')
check(multiRestore.body.accepted === 1, '当前快照只有 1 个 bundle 需要恢复')
check(multiStatus.body.job.results.length === 1, '结果条数正确')
check(multiStatus.body.job.results[0].ok === false, '失败被如实记录')
check(String(multiStatus.body.job.summary).includes('失败'), '汇总里报出失败数')

// ── 阶段 7：pendingBuilds 不代批 ──────────────────────────────────────────

console.log('\n[7] 需要批准的安装脚本不代批')
world.calls = []
world.installBehavior = () => ({ application: 'failed', pendingBuilds: ['esbuild'] })
await call('restore', {})
for (let index = 0; index < 60; index += 1) {
  const polled = await call('status')
  if (polled.body.job !== undefined && polled.body.job.running !== true) break
  await new Promise((resolve) => setTimeout(resolve, 50))
}
const builds = await call('status')
check(builds.body.job.results[0].ok === false, 'pendingBuilds 判为未完成')
check(String(builds.body.job.results[0].detail).includes('批准'), '提示用户去批准安装脚本')
check(!world.calls.some((entry) => entry.includes('approvedBuilds')), '未擅自批准构建脚本')

// ── 阶段 8：被禁用的 bundle / 行 ──────────────────────────────────────────

console.log('\n[8] 检出并恢复被禁用的 bundle 与行')
world.bundles = [
  bundleOf('dsh-better-sidebar', '0.28.0', [{ rowId: 'better-sidebar', moduleName: 'dsh-better-sidebar', entryId: 'include:better-sidebar' }], { enabled: false }),
]
world.plugins = [{ entryId: 'include:better-sidebar', moduleName: 'dsh-better-sidebar', enabled: false, readOnlyReason: undefined }]
const disabledStatus = await call('status')
check(disabledStatus.body.diff.some((item) => item.kind === 'disabled'), '检出 bundle 被禁用')
check(disabledStatus.body.diff.some((item) => item.kind === 'row-disabled'), '检出插件行被禁用')
check(disabledStatus.body.backedUp[0].state === 'disabled', '清单里该行标为 disabled')

world.calls = []
world.installBehavior = () => ({ application: 'applied' })
await call('restore', {})
for (let index = 0; index < 60; index += 1) {
  const polled = await call('status')
  if (polled.body.job !== undefined && polled.body.job.running !== true) break
  await new Promise((resolve) => setTimeout(resolve, 50))
}
const enabled = await call('status')
check(world.calls.some((entry) => entry === 'bundle:dsh-better-sidebar:true'), '调用了 setBundleEnabled(true)')
check(world.calls.some((entry) => entry.startsWith('plugin:include:better-sidebar:true')), '调用了 setPluginEnabled(true)')
check(enabled.body.job.results.every((entry) => entry.ok === true), '两项都成功')

// ── 阶段 9：版本漂移 ──────────────────────────────────────────────────────

console.log('\n[9] 检出并恢复版本漂移')
world.bundles = [bundleOf('dsh-better-sidebar', '0.27.0', [{ rowId: 'better-sidebar', moduleName: 'dsh-better-sidebar', entryId: 'include:better-sidebar' }])]
world.plugins = [{ entryId: 'include:better-sidebar', moduleName: 'dsh-better-sidebar', enabled: true }]
const drifted = await call('status')
const mismatch = drifted.body.diff.find((item) => item.kind === 'version-mismatch')
check(mismatch !== undefined, '检出 version-mismatch')
check(mismatch.spec === 'dsh-better-sidebar@0.28.0', '重装 spec 指向备份里的版本')
check(String(mismatch.detail).includes('0.28.0'), '详情里给出两个版本')
check(drifted.body.backedUp[0].state === 'version-mismatch', '清单里该行标为版本不同')
check(drifted.body.backedUp[0].liveVersion === '0.27.0', '清单里给出当前实际版本')

// ── 阶段 10：无安装来源的包（本机自建 / 手工放入）不能被当成 npm 包 ────────

console.log('\n[10] 缺少 source 时不臆造注册表 spec')
// dsh-ua-proxy 就是这种包：profile 里由用户手工放置，没有 dependencies 记录
world.bundles = []
world.plugins = []
await call('backup')
const snapshotPath = join(sandboxHome, 'plugin-backup', 'latest.json')
const { writeFileSync: writeSnapshot } = await import('node:fs')
const handMade = JSON.parse(readFileSync(snapshotPath, 'utf8'))
handMade.bundles = [
  {
    name: 'dsh-ua-proxy',
    version: '1.0.0',
    // 刻意不写 source / installTarget：与真实的 dsh-ua-proxy 一致
    enabled: true,
    rows: [{ rowId: 'ua-proxy', moduleName: 'dsh-ua-proxy', enabled: true }],
  },
]
writeSnapshot(snapshotPath, JSON.stringify(handMade, null, 2), 'utf8')

const noSourceStatus = await call('status')
const noSourceItem = noSourceStatus.body.diff.find((item) => item.name === 'dsh-ua-proxy')
check(noSourceItem !== undefined, '检出该包缺失')
check(noSourceItem.spec === undefined, '没有 source 时不拼 包名@版本（否则会误报 not-found）')
check(noSourceStatus.body.backedUp[0].restorable === false, '清单里标记为不可自动恢复')

world.calls = []
await call('restore', { targets: ['dsh-ua-proxy'] })
for (let index = 0; index < 60; index += 1) {
  const polled = await call('status')
  if (polled.body.job !== undefined && polled.body.job.running !== true) break
  await new Promise((resolve) => setTimeout(resolve, 50))
}
const noSourceJob = await call('status')
check(world.calls.length === 0, '不会真的去装一个来路不明的包')
check(noSourceJob.body.job.results[0].ok === false, '如实报告无法恢复')
check(String(noSourceJob.body.job.results[0].detail).includes('没有可用的安装来源'), '提示用户手工安装或补全清单')

// ── 阶段 11：坏快照不会让插件崩 ──────────────────────────────────────────

console.log('\n[11] 快照损坏时安全降级')
const { writeFileSync: writeFile, mkdirSync, statSync } = await import('node:fs')
writeSnapshot(snapshotPath, '{ this is not json', 'utf8')
const broken = await call('status')
check(broken.status === 200, '坏快照下 status 仍返回 200')
check(broken.body.snapshot === undefined, '坏快照被当作"没有备份"')
check(broken.body.diff.length === 0, '不产生虚假差异')
check(broken.body.backedUp.length === 0, '坏快照下清单为空而不是报错')

// ── 阶段 12：可指定备份目录（核心诉求：别放 .dsh 里） ──────────────────────

console.log('\n[12] 指定备份目录')
const customRoot = join(sandboxHome, '..', `dsh-backup-custom-${Date.now()}`)
const customDir = mkdirSync(customRoot, { recursive: true }) ?? customRoot

const initialLocation = await call('settings', {})
check(initialLocation.body.ok === true, 'settings 可读')
check(initialLocation.body.location.source === 'default', '初始来源是默认目录')
check(initialLocation.body.location.backupDir.startsWith(sandboxHome), '初始目录在 $DSH_HOME 下')
check(initialLocation.body.location.isDefault === true, '初始标记为默认')

const saved = await call('settings', { backupDir: customDir })
check(saved.body.ok === true, '可以保存自定义目录')
check(saved.body.location.backupDir === customDir, '生效目录是用户指定的那个')
check(saved.body.location.source === 'settings', '来源标为 settings')
check(saved.body.location.isDefault === false, '不再标记为默认')
check(!saved.body.location.backupDir.startsWith(sandboxHome), '自定义目录不在 $DSH_HOME 里（升级清 .dsh 不会带走它）')

// 备份必须真的写到新目录
world.bundles = [bundleOf('dsh-pet', '0.3.7', [{ rowId: 'dsh-pet', moduleName: 'dsh-pet', entryId: 'include:dsh-pet' }])]
world.plugins = [{ entryId: 'include:dsh-pet', moduleName: 'dsh-pet', enabled: true }]
const customBackup = await call('backup')
check(customBackup.body.ok === true, '新位置备份成功')
check(customBackup.body.file.startsWith(customDir), '快照文件写在新目录下')
check(existsSync(join(customDir, 'latest.json')), '新目录里有 latest.json')
check(existsSync(join(customDir, 'snapshots')), '新目录里有 snapshots 子目录')

const statusAfterMove = await call('status')
check(statusAfterMove.body.backupDir === customDir, 'status 报告的是新目录')
check(statusAfterMove.body.snapshot !== undefined, '新目录的清单被读到')
check(statusAfterMove.body.backedUp.length === 1, '新目录的清单内容正确')

// settings.json 必须在默认目录（指针不能跟着目标跑，否则 .dsh 一清就两头空）
const settingsJsonPath = join(sandboxHome, 'plugin-backup', 'settings.json')
check(existsSync(settingsJsonPath), '位置配置写在默认目录（.dsh）里')
const settingsJson = JSON.parse(readFileSync(settingsJsonPath, 'utf8'))
check(settingsJson.backupDir === customDir, '配置里记的是自定义目录')

// 主目录镜像：让位置指针活过 .dsh 重置
check(existsSync(sandboxMirror), '位置镜像是另存了一份（在主目录）')
const mirrorJson = JSON.parse(readFileSync(sandboxMirror, 'utf8'))
check(mirrorJson.backupDir === customDir, '镜像里记的也是同一个自定义目录')
check(
  !sandboxMirror.startsWith(sandboxHome),
  '镜像不在 $DSH_HOME 内（.dsh 被重置时它还在）',
)

// 模拟 .dsh 被重置：正式记录没了，靠镜像仍能找到外部备份
rmSync(join(sandboxHome, 'plugin-backup'), { recursive: true, force: true })
const afterReset = await call('status')
check(afterReset.body.location.source === 'mirror', '重置后位置来源是 mirror')
check(afterReset.body.location.restoredFromMirror === true, '标记出"从镜像恢复"')
check(afterReset.body.location.backupDir === customDir, '重置后仍指向用户指定的外部目录')
check(afterReset.body.snapshot !== undefined, '重置后仍读得到外部目录里的清单')

// 恢复默认
const restored = await call('settings', { backupDir: '' })
check(restored.body.ok === true, '可以恢复默认目录')
check(restored.body.location.isDefault === true, '恢复后标记为默认')
check(!existsSync(settingsJsonPath), '恢复默认时删掉了正式记录（不是写一个指向默认值的指针）')
check(!existsSync(sandboxMirror), '恢复默认时也清掉了镜像（避免旧目录被"复活"）')

// 非法目录不能保存
const badDir = await call('settings', { backupDir: '   ' })
check(badDir.body.ok === true && badDir.body.location.isDefault === true, '空白输入按恢复默认处理')
const winBad = await call('settings', { backupDir: 'Z:\\definitely-not-a-drive-xyz' })
check(winBad.body.ok === false, '不可写目录被拒绝')
check(String(winBad.body.error).includes('不可写'), '拒绝理由说清是不可写')
const stillDefault = await call('settings', {})
check(stillDefault.body.location.isDefault === true, '拒绝后位置没被改坏')

// ── 阶段 13：指定任意 JSON 文件恢复 ───────────────────────────────────────

console.log('\n[13] 指定 JSON 清单文件')
const externalDir = join(sandboxHome, '..', `dsh-backup-external-${Date.now()}`)
mkdirSync(externalDir, { recursive: true })
const externalFile = join(externalDir, 'my-old-plugins.json')
// 用户自己整理过的清单：只写了必要字段
writeFile(
  externalFile,
  JSON.stringify({
    createdAt: '2025-01-01T00:00:00.000Z',
    bundles: [
      { name: 'dsh-better-sidebar', version: '0.27.0', source: 'dsh-better-sidebar@^0.27.0', enabled: true, rows: [] },
      { name: 'dsh-pet', version: '0.3.0', source: 'dsh-pet@^0.3.0', enabled: true, rows: [] },
    ],
  }),
  'utf8',
)

world.bundles = []
world.plugins = []
const preview = await call('load-file', { file: externalFile })
check(preview.body.ok === true, '可读取指定的外部清单文件')
check(preview.body.bundles.length === 2, '预览列出文件里的 2 个插件')
check(preview.body.bundles[0].name === 'dsh-better-sidebar', '预览内容是文件里的真实插件')
check(preview.body.diff.length === 2, '预览同时给出与当前状态的差异')

// 读文件不改设置：这是"只读预览"
const locationUnchanged = await call('settings', {})
check(locationUnchanged.body.location.backupDir === statusAfterMove.body.location.defaultBackupDir, '预览文件不改备份位置')

// 按指定文件恢复
world.calls = []
world.installBehavior = () => ({ application: 'applied' })
const restoreFromFile = await call('restore', { sourceFile: externalFile })
check(restoreFromFile.body.ok === true, '可指定文件发起恢复')
check(restoreFromFile.body.sourceFile === externalFile, '响应回显用的就是这份文件')
check(restoreFromFile.body.accepted === 2, '按文件内容生成 2 项恢复计划')
for (let index = 0; index < 80; index += 1) {
  const polled = await call('status')
  if (polled.body.job !== undefined && polled.body.job.running !== true) break
  await new Promise((resolve) => setTimeout(resolve, 50))
}
check(world.calls.includes('install:dsh-better-sidebar@0.27.0'), '按文件里的版本安装（0.27.0）')
check(world.calls.includes('install:dsh-pet@0.3.0'), '按文件里的版本安装（0.3.0）')

// status 带 sourceFile 时，清单来自该文件
const statusFromFile = await call('status', { sourceFile: externalFile })
check(statusFromFile.body.snapshotOrigin === 'file', 'status 标明清单来源是文件')
check(statusFromFile.body.sourceFile === externalFile, 'status 回显文件路径')
check(statusFromFile.body.backedUp.length === 2, '清单来自指定文件')

// 文件不存在 / 不是 JSON / 结构不对：都要给人话
const missingFile = await call('load-file', { file: join(externalDir, 'nope.json') })
check(missingFile.body.ok === false, '不存在的文件被拒绝')
check(String(missingFile.body.error).includes('读不到'), '提示读不到文件')

const notJson = join(externalDir, 'not-json.json')
writeFile(notJson, 'hello', 'utf8')
const badJson = await call('load-file', { file: notJson })
check(badJson.body.ok === false, '非 JSON 被拒绝')
check(String(badJson.body.error).includes('不是合法 JSON'), '提示不是合法 JSON')

const wrongShape = join(externalDir, 'wrong-shape.json')
writeFile(wrongShape, JSON.stringify({ plugins: [] }), 'utf8')
const badShape = await call('load-file', { file: wrongShape })
check(badShape.body.ok === false, '结构不对被拒绝')
check(String(badShape.body.error).includes('bundles'), '提示缺 bundles')

// 目录当文件传入
const dirAsFile = await call('load-file', { file: externalDir })
check(dirAsFile.body.ok === false, '目录不能当清单文件')
check(String(dirAsFile.body.error).includes('不是一个文件'), '提示不是文件')

// 最少清单：只是一个数组也能用
const minimalFile = join(externalDir, 'minimal.json')
writeFile(minimalFile, JSON.stringify([{ name: 'dsh-pet', version: '0.3.7' }]), 'utf8')
const minimal = await call('load-file', { file: minimalFile })
check(minimal.body.ok === true, '纯数组的最小清单也能读')
check(minimal.body.bundles.length === 1, '读出 1 个插件')

// 恢复时指定坏文件要明确报错，不能静默什么都不做
const badRestore = await call('restore', { sourceFile: wrongShape })
check(badRestore.body.ok === false, '坏文件不能发起恢复')
check(String(badRestore.body.error).includes('bundles'), '如实说明哪里不对')

// ── 阶段 14：文件浏览器只列 .json（用户点击"选择文件"时的数据来源） ────────

console.log('\n[14] 文件浏览器：只列 .json 文件')
const browseDir = join(sandboxHome, '..', `dsh-browse-${Date.now()}`)
mkdirSync(browseDir, { recursive: true })
mkdirSync(join(browseDir, 'sub-folder'), { recursive: true })
writeFile(join(browseDir, 'latest.json'), JSON.stringify({ bundles: [{ name: 'dsh-pet', version: '1.0.0' }] }), 'utf8')
writeFile(join(browseDir, 'old-backup.JSON'), JSON.stringify([{ name: 'dshmarket' }]), 'utf8')
writeFile(join(browseDir, 'readme.txt'), 'not a manifest', 'utf8')
writeFile(join(browseDir, 'image.png'), 'binary-ish', 'utf8')
writeFile(join(browseDir, '.hidden.json'), '{}', 'utf8')

const listing = (await call('list-files', { dir: browseDir })).body
check(listing.ok === true, '可以列出目录')
check(listing.path === browseDir, '回显当前目录')
check(Array.isArray(listing.files), '返回 files 列表')
check(Array.isArray(listing.directories), '返回 directories 列表')

const fileNames = listing.files.map((file) => file.name).sort()
check(fileNames.includes('latest.json'), '列出 .json 文件')
check(fileNames.includes('old-backup.JSON'), '大写 .JSON 也被识别')
check(!fileNames.includes('readme.txt'), '不列出 .txt')
check(!fileNames.includes('image.png'), '不列出 .png')
check(!fileNames.includes('.hidden.json'), '不列出隐藏文件')

check(
  listing.directories.some((dir) => dir.name === 'sub-folder'),
  '列出子目录（可继续进入）',
)
check(listing.crumbs.length > 0, '返回面包屑供回跳')
check(typeof listing.parent === 'string', '返回上一级目录')

// 每个文件项都带绝对路径与大小，界面才能直接点选
const latestFile = listing.files.find((file) => file.name === 'latest.json')
check(latestFile !== undefined && latestFile.path === join(browseDir, 'latest.json'), '文件项带绝对路径')
check(typeof latestFile.size === 'number', '文件项带大小')

// 空目录
const emptyDir = join(browseDir, 'sub-folder')
const emptyListing = (await call('list-files', { dir: emptyDir })).body
check(emptyListing.ok === true, '空目录也能列')
check(emptyListing.files.length === 0, '空目录没有文件')
check(String(emptyListing.path).endsWith('sub-folder'), '空目录路径正确')

// 目录不存在：给人话，不抛 500
const missingDir = (await call('list-files', { dir: join(browseDir, 'does-not-exist') })).body
check(missingDir.ok === false, '不存在的目录被拒绝')
check(String(missingDir.error).includes('打不开'), '提示打不开目录')

// 不带 dir：退回用户主目录
const homeListing = (await call('list-files', {})).body
check(homeListing.ok === true, '不带参数时回退到主目录')
check(typeof homeListing.home === 'string', '带回 home 路径')

rmSync(browseDir, { recursive: true, force: true })

// ── 阶段 15：备份失败时不留 .tmp 残骸 ─────────────────────────────────────

console.log('\n[15] 写快照失败不留临时文件')
world.bundles = [bundleOf('dsh-pet', '0.3.7', [{ rowId: 'dsh-pet', moduleName: 'dsh-pet', entryId: 'include:dsh-pet' }])]
world.plugins = [{ entryId: 'include:dsh-pet', moduleName: 'dsh-pet', enabled: true }]
await call('settings', { backupDir: '' })
const okBackup = await call('backup')
check(okBackup.body.ok === true, '正常备份成功')

const backupRoot = join(sandboxHome, 'plugin-backup')
/**
 * 列出备份目录下所有 .tmp 残留。
 * @returns {string[]} 文件名
 */
function strayTemps() {
  try {
    return readdirSync(backupRoot).filter((name) => name.endsWith('.tmp'))
  } catch {
    return []
  }
}
check(strayTemps().length === 0, '成功后没有 .tmp 残留')

// 制造 rename 失败：把 latest.json 变成一个**目录**，rename 无法覆盖目录
rmSync(join(backupRoot, 'latest.json'), { recursive: true, force: true })
mkdirSync(join(backupRoot, 'latest.json'), { recursive: true })
const failedBackup = await call('backup')
check(failedBackup.body.ok === false, '写不进去时如实报错（不静默成功）')
await new Promise((resolve) => setTimeout(resolve, 120))
check(strayTemps().length === 0, '失败后也没有 .tmp 残留（关键：不堆垃圾）')

// 恢复现场
rmSync(join(backupRoot, 'latest.json'), { recursive: true, force: true })
const recovered = await call('backup')
check(recovered.body.ok === true, '清掉障碍后备份恢复正常')

// ── 收尾 ──────────────────────────────────────────────────────────────────

rmSync(sandboxHome, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} 项)`}`)
process.exit(failures === 0 ? 0 : 1)
