/**
 * dsh-plugin-backup —— 宿主半侧（Host half）
 *
 * 职责：把当前 profile 的已安装插件清单（包名、版本、安装来源 spec、启用状态）
 * 以可读 JSON 持久化到 **用户指定的目录**（默认 `$DSH_HOME/plugin-backup`）。
 *
 * 存储位置可配置是这个插件存在的理由之一：DSH 升级有可能整个重置 `.dsh`，
 * 把清单放在 `.dsh` 里等于把备份和要被备份的东西放在同一个篮子里。
 * 用户可以：
 *   1. 把备份目录指到 `.dsh` 之外的任意位置（如 `D:\dsh-backups`）；
 *   2. 让插件直接读取**任意一份**已有的 JSON 清单文件并据此恢复。
 *
 * 设计约束：
 *   - 只用 node 内置模块：本包不带任何依赖，避免 DSH 版本差异导致加载失败。
 *   - 恢复只走 Harness 官方插件接口 `pluginManager.installBundle` /
 *     `removeBundle` / `setBundleEnabled` / `setPluginEnabled`，不做非官方注入。
 *   - 任一插件失败只记录日志并继续（失败可恢复、整体不中断）。
 *   - 恢复前必须由用户在界面上确认清单：Host 不会自行安装任何东西，
 *     也不代批安装脚本（pendingBuilds 交回界面提示用户）。
 *   - 位置配置写失败/目标盘不可用时不崩：退回默认位置并在状态里如实报告。
 *
 * 路由（POST + JSON）：
 *   /plugin-backup/api/status        快照 + 当前安装 + 差异 + 恢复进度 + 日志 + 位置设置
 *   /plugin-backup/api/backup        立即备份
 *   /plugin-backup/api/restore       按勾选执行恢复（可指定从哪个 JSON 文件恢复）
 *   /plugin-backup/api/log           读取最近日志
 *   /plugin-backup/api/settings      读取/修改备份目录
 *   /plugin-backup/api/load-file     读取任意指定的 JSON 清单文件（只读，不落盘）
 *   /plugin-backup/api/pick-file     拉起系统原生"选文件"对话框，只挑 .json
 *   /plugin-backup/api/list-files    列目录（原生对话框不可用时的内置浏览器）
 */

import { spawn } from 'node:child_process'
import { accessSync, constants as fsConstants, statSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** 插件行 id（与 cordis.patch.yml 保持一致） */
export const name = 'plugin-backup'

/** 依赖的服务：webServer（HTTP 路由）+ tools（把只读查询暴露给 agent） */
export const inject = ['webServer', 'tools']

/** 路由前缀 */
const ROUTE_PREFIX = '/plugin-backup/api'

/** 默认备份根目录名（位于 $DSH_HOME 下，profile 之外） */
const BACKUP_DIR_NAME = 'plugin-backup'

/** 位置配置文件所在目录名（固定在默认位置：它是"指针"，必须先找得到） */
const SETTINGS_DIR_NAME = 'plugin-backup'

/** 快照格式版本：字段结构变化时递增，读取方据此兼容旧快照 */
const SNAPSHOT_VERSION = 1

/** 位置配置版本 */
const SETTINGS_VERSION = 1

/** 快照保留份数上限（超出后删除最旧的） */
const MAX_SNAPSHOTS = 20

/** 请求体大小上限 */
const MAX_BODY_BYTES = 256 * 1024

/** 指定清单文件的大小上限（防御性：不要把几百 MB 的东西读进内存） */
const MAX_SNAPSHOT_FILE_BYTES = 8 * 1024 * 1024

/** 一次最多返回给界面的日志行数 */
const LOG_TAIL_LINES = 200

/** 状态里带的日志行数（少一些，轮询更轻） */
const STATUS_LOG_LINES = 80

/** 启动自动备份的延迟：不拖慢 DSH 启动 */
const STARTUP_BACKUP_DELAY_MS = 5000

/** 同一份清单超过这个时长也会再备份一次（至少每天一份） */
const AUTO_BACKUP_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** 原生文件对话框最长等待（用户不点也不关时不要永久挂住一个 HTTP 请求） */
const NATIVE_DIALOG_TIMEOUT_MS = 5 * 60 * 1000

/**
 * 拉起系统原生"选文件"对话框所需的最小 PowerShell 脚本。
 *
 * 为什么走 PowerShell：Harness 自带的原生选择器是 Win32 COM `IFileOpenDialog`，
 * 但它把 options 硬编码成 `104`（FOS_PICKFOLDERS | FORCEFILESYSTEM | PATHMUSTEXIST），
 * 也就是**只能选文件夹**。同一套系统对话框去掉 PICKFOLDERS 就是文件对话框，
 * 由这个子进程调用 .NET 的 OpenFileDialog 打开 —— 用户看到的就是熟悉的系统对话框，
 * 可以自由切换盘符、访问"此电脑"、收藏夹等，不再是插件自绘的列表。
 *
 * 两个必须遵守的约束（都是 Windows PowerShell 5.1 的坑）：
 *   1. 脚本内容**必须是纯 ASCII**：5.1 按系统 ANSI 代码页读 .ps1，
 *      有中文注释会把脚本解析坏掉（表现为对话框弹出但不返回结果）。
 *      需要中文的地方（对话框标题）走环境变量传入，不写进脚本。
 *   2. 写文件时加 UTF-8 BOM：这是 5.1 唯一可靠识别 UTF-8 的方式。
 *
 * 协议：stdout 第一行 READY（对话框已就绪）；用户选完后把绝对路径写进
 * `$env:DSH_PICK_OUT` 指定的 UTF-8 文件（不走 stdout，避免中文路径乱码），
 * 取消则写 CANCELLED。
 */
const NATIVE_DIALOG_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = $env:DSH_PICK_TITLE
$dialog.Filter = 'Plugin manifest (*.json)|*.json|All files (*.*)|*.*'
$dialog.CheckFileExists = $true
$dialog.Multiselect = $false
$dialog.RestoreDirectory = $true
if ($env:DSH_PICK_INITIAL_DIR -and (Test-Path -LiteralPath $env:DSH_PICK_INITIAL_DIR)) {
  $dialog.InitialDirectory = $env:DSH_PICK_INITIAL_DIR
}
# Invisible always-on-top owner window: keeps the dialog in the foreground
# instead of opening behind the browser.
$owner = New-Object System.Windows.Forms.Form
$owner.Text = 'plugin-backup'
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.Opacity = 0
$owner.FormBorderStyle = 'None'
$owner.Size = New-Object System.Drawing.Size(1, 1)
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
try {
  $result = $dialog.ShowDialog($owner)
  $utf8 = New-Object System.Text.UTF8Encoding $false
  if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
    [System.IO.File]::WriteAllText($env:DSH_PICK_OUT, $dialog.FileName, $utf8)
  } else {
    [System.IO.File]::WriteAllText($env:DSH_PICK_OUT, 'CANCELLED', $utf8)
  }
} catch {
  [System.IO.File]::WriteAllText($env:DSH_PICK_OUT, 'ERROR: ' + $_.Exception.Message, (New-Object System.Text.UTF8Encoding $false))
} finally {
  $owner.Dispose()
  $dialog.Dispose()
}
`

// ────────────────────────────────────────────────────────────────────────────
// 路径、位置配置
// ────────────────────────────────────────────────────────────────────────────

/**
 * 解析 DSH 主目录：优先进程环境变量（桌面端与 CLI 都会设置），
 * 其次退回 `~/.dsh`。
 * @returns DSH 主目录绝对路径
 */
function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/**
 * 默认备份根目录。清单（很可能）放在这里；位置配置本身也固定在这里，
 * 因为"指针"必须先于"目标"被找到。
 * @returns 绝对路径
 */
function defaultBackupRoot() {
  return join(resolveDshHome(), BACKUP_DIR_NAME)
}

/**
 * 位置配置文件路径（固定在默认目录，不随用户选择漂移）。
 * @returns 绝对路径
 */
function settingsFile() {
  return join(resolveDshHome(), SETTINGS_DIR_NAME, 'settings.json')
}

/**
 * 位置配置的**用户主目录镜像**。
 *
 * 为什么需要它：位置指针如果只存在 `.dsh` 里，那么"DSH 升级重置 .dsh"会同时抹掉
 * 指针和默认位置的备份——用户以为备份全丢了，其实外部目录里的快照还好好的，
 * 只是插件不知道该去哪儿找。把指针在用户主目录里再存一份，指针就能活过 .dsh 重置。
 * 文件名带点前缀，放在主目录根下，体积极小且显眼可发现。
 *
 * `DSH_PLUGIN_BACKUP_MIRROR` 可覆盖这个路径（测试与多份 home 的场景用）。
 * @returns 绝对路径
 */
function mirrorSettingsFile() {
  const override = normalizeDirInput(process.env.DSH_PLUGIN_BACKUP_MIRROR)
  if (override !== undefined) return override
  return join(homedir(), '.dsh-plugin-backup-location.json')
}

/**
 * 给定根目录，推导全部路径。
 * @param root 备份根目录绝对路径
 * @returns 根目录、快照目录、最新快照与日志的绝对路径
 */
function pathsFor(root) {
  return {
    root,
    snapshots: join(root, 'snapshots'),
    latest: join(root, 'latest.json'),
    log: join(root, 'log.jsonl'),
  }
}

/**
 * 把一个用户输入/环境变量里的目录标准化成绝对路径。
 * 支持 `~`、`~/xxx`、相对路径（相对进程当前目录）。
 * @param input 原始输入
 * @returns 绝对路径；输入非法时返回 undefined
 */
function normalizeDirInput(input) {
  if (typeof input !== 'string') return undefined
  const trimmed = input.trim()
  if (trimmed === '') return undefined
  let expanded = trimmed
  if (expanded === '~') expanded = homedir()
  else if (/^~[\\/]/.test(expanded)) expanded = join(homedir(), expanded.slice(2))
  if (!isAbsolute(expanded)) expanded = resolve(process.cwd(), expanded)
  // 去掉末尾分隔符，保持一致比较
  const normalized = expanded.replace(/[\\/]+$/, '')
  return normalized === '' ? undefined : normalized
}

/**
 * 读取位置配置。
 *
 * 优先级：环境变量 `DSH_PLUGIN_BACKUP_DIR` > `.dsh` 里的 settings.json >
 * 用户主目录的镜像 > 默认目录。
 *
 * 环境变量排最前是刻意的：需要时可以用它把位置彻底钉死。
 * 镜像排在不存在的 .dsh 记录之后：`.dsh` 被重置后，镜像让插件仍能找到外部备份。
 * @returns 位置信息（含来源说明，便于界面解释"为什么是这个目录"）
 */
async function readSettings() {
  const fromEnv = normalizeDirInput(process.env.DSH_PLUGIN_BACKUP_DIR)
  const stored = await readJsonQuiet(settingsFile())
  const fromFile = normalizeDirInput(stored?.backupDir)
  const mirrored = fromFile === undefined ? await readJsonQuiet(mirrorSettingsFile()) : undefined
  const fromMirror = normalizeDirInput(mirrored?.backupDir)
  const backupDir = fromEnv ?? fromFile ?? fromMirror ?? defaultBackupRoot()
  return {
    backupDir,
    defaultBackupDir: defaultBackupRoot(),
    source: fromEnv !== undefined ? 'env' : fromFile !== undefined ? 'settings' : fromMirror !== undefined ? 'mirror' : 'default',
    isDefault: backupDir === defaultBackupRoot(),
    /** .dsh 里的记录已丢失但镜像还在：界面要提示用户这个目录是从镜像恢复的 */
    restoredFromMirror: fromFile === undefined && fromMirror !== undefined,
  }
}

/**
 * 写入位置配置。两处都写：`.dsh` 里的正式记录 + 用户主目录镜像。
 * 任何一处写失败不影响另一处（镜像写失败只是损失了抗重置能力，不该让保存失败）。
 * @param backupDir 目标根目录
 */
async function writeSettings(backupDir) {
  const payload = {
    schemaVersion: SETTINGS_VERSION,
    backupDir,
    updatedAt: new Date().toISOString(),
  }
  const file = settingsFile()
  await mkdir(join(file, '..'), { recursive: true })
  await writeJsonAtomic(file, payload)
  try {
    await writeJsonAtomic(mirrorSettingsFile(), payload)
  } catch {
    // 主目录不可写（少见）：正式记录已经生效，不因此让整个保存失败
  }
}

/**
 * 删除位置配置（恢复默认时调用）。两处都清，避免镜像把旧目录"复活"。
 */
async function clearSettings() {
  await rm(settingsFile(), { force: true })
  try {
    await rm(mirrorSettingsFile(), { force: true })
  } catch {
    // 删不掉镜像不影响"当前生效的是默认目录"
  }
}

/**
 * 当前生效的路径集合。
 * @returns 路径集合
 */
async function currentPaths() {
  const settings = await readSettings()
  return pathsFor(settings.backupDir)
}

/**
 * 校验一个目录能否作为备份根目录：可创建、可写。
 * 会真的写一个探测文件再删掉——只 `access()` 判定不了只读盘/配额满。
 * @param dir 目录绝对路径
 * @returns 校验结果
 */
async function validateBackupRoot(dir) {
  const normalized = normalizeDirInput(dir)
  if (normalized === undefined) return { ok: false, error: '目录路径不能为空' }
  try {
    await mkdir(normalized, { recursive: true })
    const probe = join(normalized, `.plugin-backup-probe-${process.pid}`)
    await writeFile(probe, 'probe', 'utf8')
    await rm(probe, { force: true })
    return { ok: true, dir: normalized }
  } catch (error) {
    return { ok: false, dir: normalized, error: `目录不可写：${messageOf(error)}` }
  }
}

/**
 * 确保当前备份目录存在。
 * @returns 路径集合
 */
async function ensureDirs() {
  const paths = await currentPaths()
  try {
    await mkdir(paths.snapshots, { recursive: true })
  } catch {
    // 目标盘不可用时退回默认目录，避免整个插件不可用
    const fallback = pathsFor(defaultBackupRoot())
    await mkdir(fallback.snapshots, { recursive: true })
    return fallback
  }
  return paths
}

/**
 * 读取并解析 JSON 文件；文件不存在或内容损坏时返回 undefined（不抛错）。
 * @param path 文件绝对路径
 * @returns 解析后的值，或 undefined
 */
async function readJsonQuiet(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * 原子写 JSON：先写临时文件再 rename，避免中途失败留下半个清单。
 *
 * rename 在 Windows 上可能因目标被占用/杀软扫描而失败（EPERM/EACCES）。
 * 这时**必须清掉临时文件**，否则备份目录里会堆出一串 latest.json.<pid>.tmp；
 * 短暂等待后重试几次，覆盖"文件刚好被杀软/索引器占用"的瞬时情况。
 *
 * @param path 目标文件
 * @param value 任意可 JSON 序列化的值
 */
async function writeJsonAtomic(path, value) {
  const temp = `${path}.${process.pid}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    const retryable = new Set(['EPERM', 'EACCES', 'EBUSY'])
    let lastError
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await rename(temp, path)
        return
      } catch (error) {
        lastError = error
        if (!retryable.has(error?.code)) throw error
        // 瞬时占用：等一下再改名
        await new Promise((resolveTimer) => setTimeout(resolveTimer, 60 * (attempt + 1)))
      }
    }
    throw lastError
  } finally {
    // 无论成功失败都不留 .tmp 残骸
    await rm(temp, { force: true }).catch(() => {})
  }
}

/**
 * 追加一条 JSONL 日志。日志只写本机磁盘，不上传任何位置。
 * @param entry 日志条目
 */
async function appendLog(entry) {
  try {
    const paths = await ensureDirs()
    await appendFile(paths.log, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8')
  } catch {
    // 日志失败不能影响主流程
  }
}

/**
 * 读取日志尾部（新的在后）。
 * @param limit 最多返回条数
 * @returns 日志条目数组；解析失败的行被跳过
 */
async function readLogTail(limit = LOG_TAIL_LINES) {
  try {
    const raw = await readFile((await currentPaths()).log, 'utf8')
    const lines = raw.split('\n').filter((line) => line.trim() !== '')
    const tail = lines.slice(-limit)
    const entries = []
    for (const line of tail) {
      try {
        entries.push(JSON.parse(line))
      } catch {
        entries.push({ action: 'unparsable', message: line.slice(0, 300) })
      }
    }
    return entries
  } catch {
    return []
  }
}

/**
 * 解析 DSH 运行时版本，仅用于在快照里标注"这份清单采集自哪个版本"。
 * 解析不到返回 undefined —— 不影响备份与恢复。
 * @returns 版本字符串或 undefined
 */
function resolveDshVersion() {
  const fromEnv = process.env.DSH_VERSION
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  const manifest = join(process.cwd(), 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'package.json')
  try {
    // 同步读一次：只在备份时调用，量极小
    const version = JSON.parse(readFileSync(manifest, 'utf8')).version
    if (typeof version === 'string') return version
  } catch {
    // 打包后的桌面端不暴露此路径，忽略
  }
  return undefined
}

// ────────────────────────────────────────────────────────────────────────────
// 清单采集与差异
// ────────────────────────────────────────────────────────────────────────────

/**
 * 从 `pluginManager.listBundles()` 的结果里挑出"由本 profile 安装"的 bundle。
 * 随 DSH 安装自带（availability === 'installation'）的 bundle 升级后自己会回来，
 * 不需要也无法重新安装，因此不写进可恢复清单。
 * @param bundles listBundles() 的返回值
 * @returns 归一化后的插件条目
 */
function toSnapshotBundles(bundles) {
  const result = []
  for (const bundle of Array.isArray(bundles) ? bundles : []) {
    const bundleName = typeof bundle?.name === 'string' ? bundle.name : undefined
    if (bundleName === undefined) continue
    if (bundle.availability !== 'profile') continue
    const rows = Array.isArray(bundle.rows) ? bundle.rows : []
    result.push({
      name: bundleName,
      version: typeof bundle.version === 'string' ? bundle.version : undefined,
      // 安装来源 spec（pnpm 记录的依赖值），用于按原样重装
      source: typeof bundle.source === 'string' ? bundle.source : undefined,
      // 官方目录条目的固定安装目标（精确版本），优先于 source
      installTarget:
        bundle.installTarget !== undefined && typeof bundle.installTarget.spec === 'string'
          ? { spec: bundle.installTarget.spec, version: String(bundle.installTarget.version ?? '') }
          : undefined,
      enabled: bundle.enabled === true,
      rows: rows.map((row) => ({
        rowId: typeof row?.rowId === 'string' ? row.rowId : undefined,
        moduleName: typeof row?.moduleName === 'string' ? row.moduleName : undefined,
        entryId: typeof row?.entryId === 'string' ? row.entryId : undefined,
        title: typeof row?.meta?.title === 'string' ? row.meta.title : undefined,
      })),
    })
  }
  return result
}

/**
 * 采集当前 profile 的插件清单快照。
 * @param ctx 插件上下文
 * @returns 快照对象
 */
async function collectSnapshot(ctx) {
  const manager = ctx.get('pluginManager')
  if (manager === undefined) throw new Error('宿主没有 pluginManager 服务，无法采集插件清单')
  const bundles = await manager.listBundles()
  const plugins = typeof manager.listPlugins === 'function' ? await manager.listPlugins() : []
  const snapshotBundles = toSnapshotBundles(bundles)

  // bundle 的 rows 只给出 rowId/moduleName；真正生效的启用状态在 listPlugins() 的 entry 上
  const enabledByModule = new Map()
  for (const entry of Array.isArray(plugins) ? plugins : []) {
    if (typeof entry?.moduleName === 'string') enabledByModule.set(entry.moduleName, entry.enabled === true)
  }
  for (const bundle of snapshotBundles) {
    for (const row of bundle.rows) {
      if (row.moduleName === undefined) continue
      const live = enabledByModule.get(row.moduleName)
      row.enabled = live === undefined ? true : live
    }
  }

  return {
    schemaVersion: SNAPSHOT_VERSION,
    createdAt: new Date().toISOString(),
    dshVersion: resolveDshVersion(),
    profile: process.env.DSH_PROFILE,
    bundles: snapshotBundles,
  }
}

/**
 * 计算某个备份条目的重装 spec。
 * 优先级：官方目录的精确安装目标 > 非注册表来源（按原样）> 注册表包的精确版本 > 无。
 *
 * 关键：`source` 是唯一能说明"这份包从哪儿来"的信息。缺失时**绝不**凭 `version`
 * 拼一个 `包名@版本` —— 那会把一个本机自建/手工放置的包当成 npm 包去装，报出
 * 令人误解的 not-found。宁可返回 undefined，让界面明确提示"清单里没有安装来源"。
 * @param recorded 备份里的插件条目
 * @returns pnpm 可接受的 spec，或 undefined（无法自动恢复，需要用户手工处理）
 */
function restoreSpecOf(recorded) {
  if (typeof recorded?.installTarget?.spec === 'string' && recorded.installTarget.spec !== '') return recorded.installTarget.spec
  const bundleName = typeof recorded?.name === 'string' ? recorded.name : undefined
  if (bundleName === undefined) return undefined
  const source = typeof recorded.source === 'string' && recorded.source.trim() !== '' ? recorded.source : undefined
  if (source === undefined) return undefined
  const version = typeof recorded.version === 'string' ? recorded.version : undefined

  // 非注册表来源（git / tarball / 本地目录 / workspace）只能按原样重装
  if (/^(?:[a-z+]+:)?(?:git\+|https?:|file:|link:|workspace:)/i.test(source)) return source
  // 注册表包：钉到备份时的精确版本，保证"恢复成原来那份"
  if (version !== undefined && version.trim() !== '') return `${bundleName}@${version}`
  return `${bundleName}@${source}`
}

/**
 * 计算"快照 vs 当前"的差异，也就是待恢复项。
 * missing（没装）/ version-mismatch（版本漂移）/ disabled（bundle 被禁用）/
 * row-disabled（个别插件行被禁用）/ row-missing（插件行消失）。
 * @param snapshot 上次备份
 * @param current 当前采集的快照
 * @returns 差异数组
 */
function diffSnapshot(snapshot, current) {
  const currentBundles = Array.isArray(current.bundles) ? current.bundles : []
  const currentByName = new Map(currentBundles.map((bundle) => [bundle.name, bundle]))
  const currentRows = new Map()
  for (const bundle of currentBundles) {
    for (const row of Array.isArray(bundle.rows) ? bundle.rows : []) {
      if (row.moduleName !== undefined) currentRows.set(row.moduleName, { enabled: row.enabled === true })
    }
  }

  const items = []
  for (const recorded of Array.isArray(snapshot.bundles) ? snapshot.bundles : []) {
    if (typeof recorded?.name !== 'string') continue
    const rows = Array.isArray(recorded.rows) ? recorded.rows : []
    const live = currentByName.get(recorded.name)

    if (live === undefined) {
      items.push({
        kind: 'missing',
        name: recorded.name,
        version: recorded.version,
        spec: restoreSpecOf(recorded),
        moduleName: undefined,
        detail: '备份里有这个插件，当前 profile 里没有安装。',
      })
      continue
    }

    if (
      typeof recorded.version === 'string' &&
      typeof live.version === 'string' &&
      recorded.version !== live.version
    ) {
      items.push({
        kind: 'version-mismatch',
        name: recorded.name,
        version: recorded.version,
        liveVersion: live.version,
        spec: restoreSpecOf(recorded),
        moduleName: undefined,
        detail: `备份记录 ${recorded.version}，当前是 ${live.version}。`,
      })
    }

    if (recorded.enabled === true && live.enabled !== true) {
      items.push({
        kind: 'disabled',
        name: recorded.name,
        version: recorded.version,
        moduleName: undefined,
        detail: '插件已安装，但处于禁用状态。',
      })
    }

    for (const row of rows) {
      const moduleName = row.moduleName
      if (typeof moduleName !== 'string') continue
      const liveRow = currentRows.get(moduleName)
      if (liveRow === undefined) {
        items.push({
          kind: 'row-missing',
          name: recorded.name,
          version: recorded.version,
          moduleName,
          detail: `插件行 ${moduleName} 在当前 profile 里不存在。`,
        })
        continue
      }
      if (row.enabled === true && liveRow.enabled !== true) {
        items.push({
          kind: 'row-disabled',
          name: recorded.name,
          version: recorded.version,
          moduleName,
          detail: `插件行 ${moduleName} 被禁用了。`,
        })
      }
    }
  }
  return items
}

/**
 * 读取当前备份位置的「最新快照」。
 * @returns 快照对象或 undefined
 */
async function readLatestSnapshot() {
  return readSnapshotFile((await currentPaths()).latest)
}

/**
 * 读取并校验任意一份快照文件。这是"指定 JSON 文件恢复"的读取口：
 * 不要求文件在备份目录里，也不要求名字叫 latest.json。
 * @param file 文件绝对路径
 * @returns 快照对象；文件不存在、超限或结构不对时返回带 error 的失败信息
 */
async function readSnapshotFile(file) {
  const normalized = normalizeDirInput(file)
  if (normalized === undefined) return { error: '文件路径不能为空' }
  try {
    const info = statSync(normalized)
    if (!info.isFile()) return { error: '指定路径不是一个文件' }
    if (info.size > MAX_SNAPSHOT_FILE_BYTES) {
      return { error: `文件过大（${Math.round(info.size / 1024)} KiB），不像是插件清单` }
    }
    accessSync(normalized, fsConstants.R_OK)
  } catch (error) {
    return { error: `读不到这个文件：${messageOf(error)}` }
  }

  let parsed
  try {
    parsed = JSON.parse(await readFile(normalized, 'utf8'))
  } catch (error) {
    return { error: `不是合法 JSON：${messageOf(error)}` }
  }
  const issue = validateSnapshotShape(parsed)
  if (issue !== undefined) return { error: issue }
  return { snapshot: parsed, file: normalized }
}

/**
 * 校验一份快照的结构。宽松：只要求 bundles 是数组且每项有 name，
 * 这样用户手工整理过的清单也能用。
 * @param value 已解析的 JSON
 * @returns 问题描述，或 undefined 表示可用
 */
function validateSnapshotShape(value) {
  if (value === null || typeof value !== 'object') return '内容不是一个 JSON 对象'
  if (!Array.isArray(value.bundles)) {
    // 兼容"只写了插件数组"的最小清单：[{name, version}]
    if (Array.isArray(value)) return undefined
    return '缺少 bundles 数组（应是 { "bundles": [ { "name": ... } ] } 或直接一个插件数组）'
  }
  for (const [index, bundle] of value.bundles.entries()) {
    if (bundle === null || typeof bundle !== 'object') return `bundles[${index}] 不是对象`
    if (typeof bundle.name !== 'string' || bundle.name.trim() === '') return `bundles[${index}] 缺少 name`
  }
  return undefined
}

/**
 * 把一份"可能只是数组"的清单补成标准快照形状。
 * @param parsed 解析后的 JSON
 * @returns 标准快照
 */
function asSnapshot(parsed) {
  if (Array.isArray(parsed)) {
    return {
      schemaVersion: SNAPSHOT_VERSION,
      createdAt: new Date().toISOString(),
      bundles: parsed,
      imported: true,
    }
  }
  return parsed
}

/**
 * 清理超出保留份数的旧快照。
 */
async function pruneSnapshots() {
  try {
    const paths = await ensureDirs()
    const files = (await readdir(paths.snapshots)).filter((file) => file.endsWith('.json')).sort()
    const excess = files.length - MAX_SNAPSHOTS
    for (let index = 0; index < excess; index += 1) {
      await rm(join(paths.snapshots, files[index]), { force: true })
    }
  } catch {
    // 清理失败不影响本次备份
  }
}

/**
 * 执行一次备份：采集 → 写时间戳快照 + latest.json → 清旧 → 记日志。
 * @param ctx 插件上下文
 * @param reason 触发原因（manual / startup / tool）
 * @returns 备份结果
 */
async function performBackup(ctx, reason) {
  const snapshot = await collectSnapshot(ctx)
  const paths = await ensureDirs()
  const stamp = snapshot.createdAt.replace(/[:.]/g, '-')
  const file = join(paths.snapshots, `${stamp}.json`)
  await writeJsonAtomic(file, snapshot)
  await writeJsonAtomic(paths.latest, snapshot)
  await pruneSnapshots()
  await appendLog({
    action: 'backup',
    reason,
    ok: true,
    count: snapshot.bundles.length,
    file,
    root: paths.root,
    dshVersion: snapshot.dshVersion,
  })
  return { snapshot, file, root: paths.root }
}

/**
 * 启动时的自动备份：清单没变且快照不足一天时跳过（幂等，避免刷屏）。
 * @param ctx 插件上下文
 * @returns 是否写入了新快照
 */
async function autoBackupIfChanged(ctx) {
  const previous = await readLatestSnapshot()
  const current = await collectSnapshot(ctx)
  const fingerprint = (bundle) => `${bundle.name}@${bundle.version ?? ''}:${bundle.enabled === true ? 1 : 0}`
  const same =
    previous !== undefined &&
    !previous.error &&
    JSON.stringify((previous.snapshot.bundles ?? []).map(fingerprint)) === JSON.stringify(current.bundles.map(fingerprint))
  const writtenAt = previous === undefined || previous.error ? Number.NaN : Date.parse(previous.snapshot.createdAt)
  const fresh = Number.isFinite(writtenAt) && Date.now() - writtenAt < AUTO_BACKUP_MAX_AGE_MS
  if (same && fresh) return false
  await performBackup(ctx, 'startup')
  return true
}

// ────────────────────────────────────────────────────────────────────────────
// 恢复
// ────────────────────────────────────────────────────────────────────────────

/**
 * 找到可用的 PowerShell 可执行文件：优先 PowerShell 7，退回 Windows 自带的 Windows PowerShell。
 *
 * 只用**绝对路径**探测，不靠 PATH、也不 spawn 试探：spawn 找不到可执行文件是
 * **异步** error 事件，同步探测拦不住，反而会抛出未处理的 'error' 崩溃进程。
 * @returns 可执行文件绝对路径，或 undefined（非 Windows / 都没有）
 */
function resolvePowerShell() {
  if (process.platform !== 'win32') return undefined
  const candidates = []
  // PowerShell 7 的常见安装位置
  if (process.env.ProgramFiles !== undefined) {
    candidates.push(join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe'))
  }
  if (process.env.ProgramW6432 !== undefined) {
    candidates.push(join(process.env.ProgramW6432, 'PowerShell', '7', 'pwsh.exe'))
  }
  // Windows 自带的 Windows PowerShell 恒定存在于 System32
  candidates.push(
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  )
  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      // 试下一个
    }
  }
  return undefined
}

/**
 * 拉起系统原生的"选文件"对话框，等用户选一个 .json。
 *
 * 用子进程而不是在当前进程里开窗：Harness 的宿主进程没有消息循环，
 * 直接调 WinForms 对话框会挂住事件循环并可能永不出现在前台。
 *
 * @param options 标题与初始目录
 * @returns 选中的绝对路径 / 取消 / 失败原因
 */
async function pickJsonFileNative(options = {}) {
  const powershell = resolvePowerShell()
  if (powershell === undefined) {
    return { ok: false, unsupported: true, error: '这个系统没有可用的原生文件对话框（仅 Windows 支持）' }
  }

  let workdir
  try {
    workdir = mkdtempSync(join(tmpdir(), 'dsh-plugin-backup-pick-'))
    const scriptPath = join(workdir, 'pick-json.ps1')
    const outPath = join(workdir, 'picked.txt')
    // 带 UTF-8 BOM 写脚本：Windows PowerShell 5.1 只有见到 BOM 才按 UTF-8 解析。
    // 脚本本身是纯 ASCII，BOM 是双保险（另见 NATIVE_DIALOG_SCRIPT 的注释）。
    writeFileSync(scriptPath, `\uFEFF${NATIVE_DIALOG_SCRIPT}`, 'utf8')

    const result = await new Promise((resolvePromise) => {
      const child = spawn(
        powershell,
        ['-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          env: {
            ...process.env,
            DSH_PICK_TITLE: String(options.title ?? 'Choose a plugin manifest JSON'),
            DSH_PICK_INITIAL_DIR: String(options.initialDir ?? ''),
            DSH_PICK_OUT: outPath,
          },
        },
      )

      let stdout = ''
      let stderr = ''
      let settled = false
      /** 只结算一次 */
      const finish = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolvePromise(value)
      }

      /** 子进程结束后读它写下的结果文件（UTF-8，中文路径不会乱码）。 */
      const readResult = () => {
        let answer
        try {
          answer = readFileSync(outPath, 'utf8').trim()
        } catch (error) {
          // 把子进程的 stderr 一起报出来：这是唯一能看到 PowerShell 内部失败原因的线索
          const detail = stderr.trim() === '' ? messageOf(error) : stderr.trim().slice(0, 400)
          return { ok: false, error: `对话框没有返回结果：${detail}` }
        }
        if (answer === '') return { ok: false, error: '对话框没有返回结果' }
        if (answer === 'CANCELLED') return { ok: true, cancelled: true }
        if (answer.startsWith('ERROR:')) return { ok: false, error: answer.slice(6).trim() }
        return { ok: true, file: answer }
      }

      const timer = setTimeout(() => {
        // 用户既不选也不关：收掉子进程，别让 HTTP 请求永远挂着
        try {
          child.kill()
        } catch {
          // 已经退出了
        }
        finish({ ok: false, error: '对话框超时未响应', timedOut: true })
      }, NATIVE_DIALOG_TIMEOUT_MS)
      timer.unref?.()

      child.stdout.on('data', (chunk) => {
        stdout += String(chunk)
      })
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk)
      })
      child.on('error', (error) => finish({ ok: false, error: `无法启动对话框进程：${messageOf(error)}` }))
      child.on('close', (code) => {
        // 正常情况下由结果文件给出答案；stdout 只用来判断是否真的弹出过对话框
        if (!stdout.includes('READY')) {
          finish({
            ok: false,
            error: `对话框没能打开${stderr.trim() === '' ? '' : `：${stderr.trim().slice(0, 400)}`}`,
          })
          return
        }
        const outcome = readResult()
        if (outcome.ok !== true) {
          // 带上退出码与 stderr：这两条是排查"对话框提前退出"的唯一线索
          const parts = [outcome.error]
          if (code !== null && code !== 0) parts.push(`退出码 ${code}`)
          if (stderr.trim() !== '') parts.push(stderr.trim().slice(0, 400))
          finish({ ok: false, error: parts.join('；') })
          return
        }
        finish(outcome)
      })
    })

    return result
  } catch (error) {
    return { ok: false, error: `打开对话框失败：${messageOf(error)}` }
  } finally {
    if (workdir !== undefined) {
      try {
        rmSync(workdir, { recursive: true, force: true })
      } catch {
        // 临时文件删不掉不影响结果
      }
    }
  }
}

/**
 * 列出某个目录下可作为清单的条目，供界面的文件浏览器使用。
 *
 * 为什么要自己实现：宿主只提供**目录**选择器（`uiWorkspace.pickDirectory` →
 * `showOpenDialog({ properties: ['openDirectory'] })`），没有对外暴露"选文件"的
 * Remote 接口。而用户要的恰恰是挑一个 .json 文件。所以这里由 Host 列目录，
 * 界面用同样的视觉语言渲染一个只认 .json 的浏览器。
 *
 * @param dir 起始目录（空则用主目录）
 * @returns 目录内容、面包屑与可选取项
 */
async function listForPicker(dir) {
  const start = normalizeDirInput(dir) ?? homedir()
  let entries
  try {
    entries = await readdir(start, { withFileTypes: true })
  } catch (error) {
    return { ok: false, error: `打不开这个目录：${messageOf(error)}` }
  }

  /** 可选的清单文件：只认 .json，避免用户误选别的文件 */
  const files = []
  /** 可进入的子目录 */
  const directories = []
  for (const entry of entries) {
    // 跳过隐藏项与系统脏目录，减少干扰
    if (entry.name.startsWith('.')) continue
    if (entry.name === 'node_modules' || entry.name === '$RECYCLE.BIN' || entry.name === 'System Volume Information') continue
    const full = join(start, entry.name)
    let isDirectory = entry.isDirectory()
    let isFile = entry.isFile()
    // Windows 的目录联接/符号链接：Dirent 给的是 link，用 stat 兜一次
    if (entry.isSymbolicLink()) {
      try {
        const info = statSync(full)
        isDirectory = info.isDirectory()
        isFile = info.isFile()
      } catch {
        continue
      }
    }
    if (isDirectory) {
      directories.push({ name: entry.name, path: full })
      continue
    }
    if (!isFile) continue
    if (!/\.json$/i.test(entry.name)) continue
    let size
    try {
      size = statSync(full).size
    } catch {
      continue
    }
    files.push({ name: entry.name, path: full, size })
  }

  directories.sort((left, right) => left.name.localeCompare(right.name))
  files.sort((left, right) => left.name.localeCompare(right.name))

  // 面包屑：从根到当前目录，供界面一键回跳
  const crumbs = []
  let cursor = start
  for (let depth = 0; depth < 64; depth += 1) {
    crumbs.unshift({ name: cursor === dirname(cursor) ? cursor : cursor.split(/[\\/]/).pop(), path: cursor })
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }

  return {
    ok: true,
    path: start,
    home: homedir(),
    parent: dirname(start) === start ? undefined : dirname(start),
    crumbs,
    directories,
    files,
  }
}

/**
 * 把任意异常变成一行可读文本。
 * @param error 捕获到的异常
 * @returns 文本
 */
function messageOf(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** 一次恢复任务：串行推进、逐项记录、失败继续。 */
class RestoreJob {
  /**
   * @param ctx 插件上下文
   * @param items 待恢复项（来自 diffSnapshot）
   */
  constructor(ctx, items) {
    this.ctx = ctx
    this.items = items
    this.startedAt = new Date().toISOString()
    this.state = { running: true, total: items.length, done: 0, current: undefined, results: [] }
  }

  /**
   * 记录一项结果。
   * @param item 恢复项
   * @param ok 是否成功
   * @param detail 可读说明
   * @param extra 附加字段
   */
  record(item, ok, detail, extra) {
    const entry = {
      kind: item.kind,
      name: item.name,
      moduleName: item.moduleName,
      ok,
      detail,
      ...(extra === undefined ? {} : extra),
    }
    this.state.results.push(entry)
    this.state.done += 1
    this.state.current = undefined
    void appendLog({ action: 'restore-item', ok, ...entry })
  }

  /**
   * 执行整份恢复计划。
   * @returns 任务结束时的状态
   */
  async run() {
    const manager = this.ctx.get('pluginManager')
    if (manager === undefined) {
      this.state.running = false
      this.state.error = '宿主没有 pluginManager 服务，无法恢复'
      return this.state
    }

    // 按插件名归并：先装/换版本，再启用 bundle，最后启用单行
    const byName = new Map()
    for (const item of this.items) {
      const list = byName.get(item.name)
      if (list === undefined) byName.set(item.name, [item])
      else list.push(item)
    }

    for (const [bundleName, items] of byName) {
      this.state.current = bundleName
      const reinstall = items.filter((item) => item.kind === 'missing' || item.kind === 'version-mismatch')
      let installed = true

      if (reinstall.length > 0) {
        const spec = reinstall.map((item) => item.spec).find((value) => typeof value === 'string')
        if (spec === undefined) {
          for (const item of reinstall) this.record(item, false, '清单里没有可用的安装来源，请手工安装或补全快照')
          installed = false
        } else {
          const outcome = await this.installOne(manager, bundleName, spec)
          for (const item of reinstall) this.record(item, outcome.ok, outcome.detail, outcome.extra)
          installed = outcome.ok
        }
      }

      if (installed) {
        const disabled = items.filter((item) => item.kind === 'disabled')
        if (disabled.length > 0) await this.enableBundle(manager, bundleName, disabled)
        await this.restoreRows(manager, items)
      }
    }

    this.state.running = false
    this.state.finishedAt = new Date().toISOString()
    const failed = this.state.results.filter((entry) => entry.ok !== true).length
    this.state.summary = failed === 0 ? '全部恢复完成' : `完成，其中 ${failed} 项失败（详见日志）`
    void appendLog({
      action: 'restore',
      ok: failed === 0,
      total: this.state.total,
      failed,
      startedAt: this.startedAt,
    })
    return this.state
  }

  /**
   * 安装（或换版本重装）一个 bundle。
   * 已装过时 pnpm 会以 `already-installed` 拒绝：按官方插件页同样的两步法先移除再安装。
   * 需要批准的安装脚本**不代批**，交回界面提示用户。
   * @param manager pluginManager 服务
   * @param bundleName bundle 包名
   * @param spec 安装 spec
   * @returns 结果与说明
   */
  async installOne(manager, bundleName, spec) {
    try {
      let result = await manager.installBundle(spec)
      if (result !== undefined && result.application === 'failed' && result.error !== undefined && result.error.code === 'already-installed') {
        const removed = await manager.removeBundle(bundleName)
        if (removed !== undefined && (removed.application === 'failed' || removed.application === 'cancelled')) {
          return { ok: false, detail: `移除已安装版本失败：${removed.error?.code ?? 'unknown'}`, extra: {} }
        }
        result = await manager.installBundle(spec)
      }
      const pendingBuilds = Array.isArray(result?.pendingBuilds) ? result.pendingBuilds : []
      if (pendingBuilds.length > 0) {
        return {
          ok: false,
          detail: `安装脚本待批准：${pendingBuilds.join(', ')}（请在「设置 → 插件」里确认后重试）`,
          extra: { pendingBuilds },
        }
      }
      const application = result?.application
      if (application === 'applied') return { ok: true, detail: '已安装并生效', extra: { application } }
      if (application === 'restart-required') return { ok: true, detail: '已安装，重启 DSH 后生效', extra: { application } }
      if (application === 'overridden') return { ok: true, detail: '已安装，但被更高优先级的层覆盖（未生效）', extra: { application } }
      const code = result?.error?.code ?? result?.packageResult?.kind ?? 'unknown'
      return { ok: false, detail: `安装失败：${code}`, extra: { application, code } }
    } catch (error) {
      const code = error !== null && typeof error === 'object' ? error.code : undefined
      if (code === 'incompatible-version') {
        return { ok: false, detail: `与当前 DSH 版本不兼容：${messageOf(error)}`, extra: { code } }
      }
      return { ok: false, detail: `安装异常：${messageOf(error)}`, extra: code === undefined ? {} : { code } }
    }
  }

  /**
   * 启用一个被禁用的 bundle。
   * @param manager pluginManager 服务
   * @param bundleName bundle 包名
   * @param items 归属该 bundle 的待恢复项
   */
  async enableBundle(manager, bundleName, items) {
    try {
      const result = await manager.setBundleEnabled(bundleName, true)
      const application = result?.application
      const ok = application === 'applied' || application === 'overridden' || application === 'restart-required'
      for (const item of items) {
        this.record(item, ok, ok ? `已启用（${application}）` : `启用失败：${result?.error?.code ?? 'unknown'}`)
      }
    } catch (error) {
      for (const item of items) this.record(item, false, `启用失败：${messageOf(error)}`)
    }
  }

  /**
   * 把快照里"当时启用、现在被禁用/缺失"的行重新启用。
   * @param manager pluginManager 服务
   * @param items 归属同一 bundle 的待恢复项
   */
  async restoreRows(manager, items) {
    const rowItems = items.filter((item) => item.kind === 'row-disabled' || item.kind === 'row-missing')
    if (rowItems.length === 0) return
    let plugins
    try {
      plugins = await manager.listPlugins()
    } catch (error) {
      for (const item of rowItems) this.record(item, false, `读取插件行失败：${messageOf(error)}`)
      return
    }
    const list = Array.isArray(plugins) ? plugins : []
    for (const item of rowItems) {
      const moduleName = item.moduleName
      const live = list.find((entry) => entry?.moduleName === moduleName)
      if (live === undefined) {
        this.record(item, false, '当前 profile 里没有这一行：重装插件后应会自动出现')
        continue
      }
      if (live.enabled === true) {
        this.record(item, true, '跳过：已经是启用状态')
        continue
      }
      if (live.readOnlyReason !== undefined) {
        this.record(item, false, `这一行不允许通过插件列表修改（${live.readOnlyReason}）`)
        continue
      }
      try {
        const result = await manager.setPluginEnabled(live.entryId, true)
        const application = result?.application
        const ok = application === 'applied' || application === 'overridden' || application === 'restart-required'
        this.record(item, ok, ok ? `已启用（${application}）` : `启用失败：${result?.error?.code ?? 'unknown'}`)
      } catch (error) {
        this.record(item, false, `启用失败：${messageOf(error)}`)
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// HTTP 层
// ────────────────────────────────────────────────────────────────────────────

/**
 * 读取完整请求体并解析 JSON。
 * @param req 请求
 * @returns 解析后的对象（空体视作 {}）
 */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  return parsed !== null && typeof parsed === 'object' ? parsed : {}
}

/**
 * 写 JSON 响应。
 * @param res 响应
 * @param status HTTP 状态码
 * @param body 响应体
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * 把快照里的每个插件翻译成"界面上可读的一行"：备份了什么，现在处于什么状态。
 *
 * 这是用户要看的"已备份的插件清单"本身——即使没有任何差异（全部正常），
 * 也应该能看到备份里到底有哪些插件，而不是只看到"没有需要恢复的"。
 * @param snapshot 备份快照
 * @param current 当前采集的快照（可能因 pluginManager 不可用而缺失）
 * @param diff 差异数组
 * @returns 每个备份插件的展示行
 */
function describeBackedUp(snapshot, current, diff) {
  const currentByName = new Map((current?.bundles ?? []).map((bundle) => [bundle.name, bundle]))
  /** 某个插件的差异种类集合 */
  const kindsByName = new Map()
  for (const item of diff) {
    const kinds = kindsByName.get(item.name)
    if (kinds === undefined) kindsByName.set(item.name, new Set([item.kind]))
    else kinds.add(item.kind)
  }

  return (snapshot.bundles ?? []).map((recorded) => {
    const live = currentByName.get(recorded.name)
    const kinds = kindsByName.get(recorded.name)
    let state = 'ok'
    if (live === undefined) state = 'missing'
    else if (kinds?.has('version-mismatch') === true) state = 'version-mismatch'
    else if (kinds?.has('disabled') === true) state = 'disabled'
    else if (kinds !== undefined && kinds.size > 0) state = 'partial'

    return {
      name: recorded.name,
      version: recorded.version,
      source: recorded.source,
      installTarget: recorded.installTarget?.spec,
      /** 备份时这个 bundle 是否启用 */
      enabled: recorded.enabled === true,
      /** 备份时的插件行数 */
      rows: Array.isArray(recorded.rows) ? recorded.rows.length : 0,
      /** 当前实际安装的版本（缺失时为空） */
      liveVersion: live?.version,
      /** ok / missing / version-mismatch / disabled / partial（部分行有问题） */
      state,
      /** 能否自动恢复：没有安装来源就不能 */
      restorable: restoreSpecOf(recorded) !== undefined,
    }
  })
}

/**
 * 描述当前生效的备份位置，供界面展示与解释。
 * @returns 位置信息
 */
async function describeLocation() {
  const settings = await readSettings()
  const paths = pathsFor(settings.backupDir)
  let writable = true
  try {
    const verdict = await validateBackupRoot(settings.backupDir)
    writable = verdict.ok
  } catch {
    writable = false
  }
  return {
    backupDir: settings.backupDir,
    defaultBackupDir: settings.defaultBackupDir,
    source: settings.source,
    isDefault: settings.isDefault,
    /** .dsh 记录丢了、靠主目录镜像找回来的（界面要提示重新保存一次） */
    restoredFromMirror: settings.restoredFromMirror === true,
    writable,
    settingsFile: settingsFile(),
    mirrorFile: mirrorSettingsFile(),
    latestFile: paths.latest,
    logFile: paths.log,
  }
}

/**
 * 组装 /status 的返回体。
 * @param ctx 插件上下文
 * @param job 当前/最近一次恢复任务状态
 * @param sourceFile 可选的指定清单文件（用户手动选的 JSON）
 * @returns 状态对象
 */
async function buildStatus(ctx, job, sourceFile) {
  const location = await describeLocation()
  const fromFile = normalizeDirInput(sourceFile)

  // 快照来源：指定文件 > 当前位置的 latest.json
  let snapshot
  let snapshotError
  let snapshotOrigin = 'latest'
  if (fromFile !== undefined) {
    snapshotOrigin = 'file'
    const loaded = await readSnapshotFile(fromFile)
    if (loaded.error !== undefined) snapshotError = loaded.error
    else snapshot = asSnapshot(loaded.snapshot)
  } else {
    const loaded = await readLatestSnapshot()
    if (loaded !== undefined && loaded.error !== undefined) snapshotError = loaded.error
    else if (loaded !== undefined) snapshot = loaded.snapshot
  }

  let current
  let currentError
  try {
    current = await collectSnapshot(ctx)
  } catch (error) {
    currentError = messageOf(error)
  }
  const diff = snapshot !== undefined && current !== undefined ? diffSnapshot(snapshot, current) : []
  return {
    ok: currentError === undefined,
    error: currentError,
    backupDir: location.backupDir,
    latestFile: location.latestFile,
    location,
    sourceFile: fromFile,
    snapshotOrigin,
    snapshotError,
    snapshot:
      snapshot === undefined
        ? undefined
        : {
            createdAt: snapshot.createdAt,
            count: Array.isArray(snapshot.bundles) ? snapshot.bundles.length : 0,
            dshVersion: snapshot.dshVersion,
          },
    /** 备份里实际有哪些插件（用户要看的清单本体） */
    backedUp: snapshot === undefined ? [] : describeBackedUp(snapshot, current, diff),
    current:
      current === undefined
        ? undefined
        : {
            count: current.bundles.length,
            dshVersion: current.dshVersion,
            bundles: current.bundles.map((bundle) => ({
              name: bundle.name,
              version: bundle.version,
              enabled: bundle.enabled,
              rows: bundle.rows.length,
            })),
          },
    diff,
    managerAvailable: ctx.get('pluginManager') !== undefined,
    job,
    log: await readLogTail(STATUS_LOG_LINES),
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 插件入口
// ────────────────────────────────────────────────────────────────────────────

/**
 * 插件主体：HTTP 路由、启动自动备份、只读的 agent 工具。
 * 安装类动作永远由用户在界面上确认后触发；工具不会安装任何东西。
 * @param ctx 插件上下文
 */
export function apply(ctx) {
  /** 正在运行的恢复任务 */
  let activeJob
  /** 最近一次结束的任务状态（界面要展示结果） */
  let lastJobState

  // 启动自动备份：延迟执行，失败只记日志
  ctx.effect(() => {
    const timer = setTimeout(() => {
      void autoBackupIfChanged(ctx).catch((error) => {
        void appendLog({ action: 'backup', reason: 'startup', ok: false, message: messageOf(error) })
      })
    }, STARTUP_BACKUP_DELAY_MS)
    timer.unref?.()
    return () => clearTimeout(timer)
  }, 'plugin-backup: startup auto backup')

  // HTTP 路由
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          // 复用宿主自己的请求闸门（来源校验 + 登录态），避免任意网页触发本机插件安装
          const connection = ctx.get('connection')
          if (connection !== undefined && typeof connection.requestRejection === 'function') {
            const rejection = connection.requestRejection(req)
            if (rejection !== undefined) {
              sendJson(res, 403, { ok: false, error: 'forbidden' })
              return
            }
          }
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
          const method = pathname.startsWith(`${ROUTE_PREFIX}/`) ? pathname.slice(ROUTE_PREFIX.length + 1) : ''
          try {
            const body = await readBody(req)
            if (method === 'status') {
              sendJson(
                res,
                200,
                await buildStatus(
                  ctx,
                  activeJob !== undefined ? activeJob.state : lastJobState,
                  typeof body.sourceFile === 'string' ? body.sourceFile : undefined,
                ),
              )
              return
            }
            if (method === 'backup') {
              const result = await performBackup(ctx, 'manual')
              sendJson(res, 200, {
                ok: true,
                file: result.file,
                root: result.root,
                count: result.snapshot.bundles.length,
                createdAt: result.snapshot.createdAt,
              })
              return
            }
            if (method === 'log') {
              sendJson(res, 200, { ok: true, entries: await readLogTail(LOG_TAIL_LINES) })
              return
            }
            if (method === 'settings') {
              // GET 语义：只读当前配置
              if (body.backupDir === undefined) {
                sendJson(res, 200, { ok: true, location: await describeLocation() })
                return
              }
              // PUT 语义：改位置。空字符串/缺省 = 恢复默认
              const requested = typeof body.backupDir === 'string' ? body.backupDir.trim() : ''
              const target = requested === '' ? defaultBackupRoot() : normalizeDirInput(requested)
              if (target === undefined) {
                sendJson(res, 200, { ok: false, error: '目录路径不能为空' })
                return
              }
              const verdict = await validateBackupRoot(target)
              if (!verdict.ok) {
                sendJson(res, 200, { ok: false, error: verdict.error })
                return
              }
              // 切到默认目录等于"删掉自定义指针"，而不是把一个指向默认值的指针写进文件
              if (verdict.dir === defaultBackupRoot()) await clearSettings()
              else await writeSettings(verdict.dir)
              await appendLog({ action: 'settings', ok: true, backupDir: verdict.dir })
              sendJson(res, 200, { ok: true, location: await describeLocation() })
              return
            }
            if (method === 'pick-file') {
              // 系统原生"选文件"对话框：会话里可以随意切盘符、逛"此电脑"
              const picked = await pickJsonFileNative({
                title: '选择一个插件清单 JSON',
                initialDir: typeof body.initialDir === 'string' ? body.initialDir : undefined,
              })
              if (picked.ok !== true) {
                sendJson(res, 200, { ok: false, unsupported: picked.unsupported === true, error: picked.error })
                return
              }
              if (picked.cancelled === true) {
                sendJson(res, 200, { ok: true, cancelled: true })
                return
              }
              // 选完立刻读取，界面拿到的就是清单内容（省一次往返）
              const loaded = await readSnapshotFile(picked.file)
              if (loaded.error !== undefined) {
                sendJson(res, 200, { ok: false, file: picked.file, error: loaded.error })
                return
              }
              const snapshot = asSnapshot(loaded.snapshot)
              let diff = []
              try {
                diff = diffSnapshot(snapshot, await collectSnapshot(ctx))
              } catch {
                // 采不到当前状态就只回清单
              }
              sendJson(res, 200, {
                ok: true,
                file: picked.file,
                snapshot: { createdAt: snapshot.createdAt, count: snapshot.bundles.length, dshVersion: snapshot.dshVersion },
                bundles: snapshot.bundles.map((bundle) => ({
                  name: bundle.name,
                  version: bundle.version,
                  source: bundle.source,
                  enabled: bundle.enabled === true,
                  restorable: restoreSpecOf(bundle) !== undefined,
                })),
                diff,
              })
              return
            }
            if (method === 'list-files') {
              // 供界面的文件浏览器列目录：只回 .json 文件与子目录
              sendJson(res, 200, await listForPicker(typeof body.dir === 'string' ? body.dir : undefined))
              return
            }
            if (method === 'load-file') {
              // 只读地预览一份指定清单，不落盘、不改设置：用户先看清楚再决定用不用
              const loaded = await readSnapshotFile(typeof body.file === 'string' ? body.file : '')
              if (loaded.error !== undefined) {
                sendJson(res, 200, { ok: false, error: loaded.error })
                return
              }
              const snapshot = asSnapshot(loaded.snapshot)
              let diff = []
              try {
                diff = diffSnapshot(snapshot, await collectSnapshot(ctx))
              } catch {
                // 采不到当前状态就只回清单，不影响预览
              }
              sendJson(res, 200, {
                ok: true,
                file: loaded.file,
                snapshot: {
                  createdAt: snapshot.createdAt,
                  count: snapshot.bundles.length,
                  dshVersion: snapshot.dshVersion,
                },
                bundles: snapshot.bundles.map((bundle) => ({
                  name: bundle.name,
                  version: bundle.version,
                  source: bundle.source,
                  enabled: bundle.enabled === true,
                  restorable: restoreSpecOf(bundle) !== undefined,
                })),
                diff,
              })
              return
            }
            if (method === 'restore') {
              if (activeJob !== undefined) {
                sendJson(res, 409, { ok: false, error: '已经有一个恢复任务在运行' })
                return
              }
              // 恢复来源：用户指定的 JSON 文件 > 当前位置的 latest.json
              const fromFile = normalizeDirInput(body.sourceFile)
              let snapshot
              if (fromFile !== undefined) {
                const loaded = await readSnapshotFile(fromFile)
                if (loaded.error !== undefined) {
                  sendJson(res, 200, { ok: false, error: loaded.error })
                  return
                }
                snapshot = asSnapshot(loaded.snapshot)
              } else {
                const loaded = await readLatestSnapshot()
                if (loaded === undefined || loaded.error !== undefined) {
                  sendJson(res, 200, { ok: false, error: '还没有备份，请先执行一次备份' })
                  return
                }
                snapshot = loaded.snapshot
              }
              const requested = Array.isArray(body.targets) ? body.targets.filter((value) => typeof value === 'string') : []
              const current = await collectSnapshot(ctx)
              const all = diffSnapshot(snapshot, current)
              // 未指定 targets 时恢复全部差异；指定时只恢复勾选项（按插件名匹配）
              const plan = requested.length === 0 ? all : all.filter((item) => requested.includes(item.name))
              if (plan.length === 0) {
                sendJson(res, 200, { ok: true, restored: 0, message: '没有需要恢复的插件' })
                return
              }
              const job = new RestoreJob(ctx, plan)
              activeJob = job
              lastJobState = job.state
              void job
                .run()
                .catch((error) => {
                  job.state.running = false
                  job.state.error = messageOf(error)
                  void appendLog({ action: 'restore', ok: false, message: messageOf(error) })
                })
                .finally(() => {
                  // 任务结束后释放占用，允许下一次恢复
                  if (activeJob === job) activeJob = undefined
                })
              void appendLog({
                action: 'restore',
                ok: true,
                source: fromFile === undefined ? 'latest' : fromFile,
                planned: plan.length,
              })
              sendJson(res, 200, { ok: true, accepted: plan.length, sourceFile: fromFile, job: job.state })
              return
            }
            sendJson(res, 404, { ok: false, error: `未知方法 ${method}` })
          } catch (error) {
            sendJson(res, 500, { ok: false, error: messageOf(error) })
          }
        },
      }),
    'plugin-backup: /plugin-backup/api route',
  )

  // 只读/备份工具。恢复要安装包，保留为用户在界面上的显式操作。
  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'plugin_backup',
        description:
          'Inspect or refresh the local plugin backup of this DSH profile. action=status returns the snapshot location, the backed-up plugin list, the current plugin set, and the differences (missing bundles, version mismatches, disabled bundles or plugin rows); action=backup writes a new JSON snapshot into the configured backup directory. The backup directory is user-configurable because a Harness update can reset all of $DSH_HOME; pass file to read one specific JSON snapshot instead of the current latest.json. Restoring installs packages, so it stays a user action in Settings → Plugins → Backup & Restore; this tool never installs anything.',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              description: 'status (read the snapshot and differences) or backup (write a new snapshot now).',
              enum: ['status', 'backup'],
            },
            file: {
              type: 'string',
              description:
                'Optional absolute path to a specific JSON snapshot to read or restore from, instead of the configured latest.json. Ignored by action=backup.',
            },
          },
          required: ['action'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              action: { type: 'string' },
              summary: { type: 'string' },
              detail: { type: 'string' },
            },
            required: ['action', 'summary'],
            additionalProperties: false,
          },
          render: (_args, value) => [{ type: 'text', text: value.detail === undefined ? value.summary : `${value.summary}\n\n${value.detail}` }],
        },
        execute: async (args) => {
          const action = args !== null && typeof args === 'object' && args.action === 'backup' ? 'backup' : 'status'
          const file = args !== null && typeof args === 'object' && typeof args.file === 'string' ? args.file : undefined
          if (action === 'backup') {
            const result = await performBackup(ctx, 'tool')
            return {
              action,
              summary: `已备份 ${result.snapshot.bundles.length} 个插件。`,
              detail: `目录：${result.root}\n文件：${result.file}`,
            }
          }
          const status = await buildStatus(ctx, activeJob !== undefined ? activeJob.state : lastJobState, file)
          const lines = [
            `备份目录：${status.backupDir}${status.location.isDefault ? '（默认）' : ''}`,
            status.sourceFile === undefined ? '' : `读取的清单文件：${status.sourceFile}`,
            status.snapshotError === undefined ? '' : `读取失败：${status.snapshotError}`,
            status.snapshot === undefined
              ? '还没有备份。'
              : `上次备份：${status.snapshot.createdAt}（${status.snapshot.count} 个插件${status.snapshot.dshVersion === undefined ? '' : `，DSH ${status.snapshot.dshVersion}`}）`,
            `当前 profile 安装 ${status.current === undefined ? 0 : status.current.count} 个插件。`,
            status.backedUp.length === 0 ? '' : '备份里的插件：',
            ...status.backedUp.map(
              (item) =>
                `- ${item.name}@${item.version ?? '?'}（${item.state}${item.liveVersion === undefined ? '' : `，当前 ${item.liveVersion}`}）${item.restorable ? '' : ' — 没有安装来源，无法自动恢复'}`,
            ),
            status.snapshot === undefined ? '' : status.diff.length === 0 ? '未检测到需要恢复的差异。' : '检测到以下差异：',
            ...status.diff.map(
              (item) =>
                `- [${item.kind}] ${item.name}${item.moduleName === undefined ? '' : ` / ${item.moduleName}`}：${item.detail}`,
            ),
          ].filter((line) => line !== '')
          return { action, summary: lines.join('\n'), detail: status.latestFile }
        },
      }),
    'plugin-backup: plugin_backup tool',
  )
}
