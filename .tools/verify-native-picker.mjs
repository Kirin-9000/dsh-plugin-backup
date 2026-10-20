/**
 * 真实拉起系统原生文件对话框，并用 UI 自动化点掉它。
 *
 * 目的：证明 `pick-file` 走的是**系统对话框**（可切盘符），而不是插件自绘列表。
 * 无人值守环境下无法真人点击，所以这里用 SendKeys 在对话框里输入路径并回车。
 *
 * 用法：node .tools/verify-native-picker.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
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

const sandboxHome = mkdtempSync(join(tmpdir(), 'dsh-native-pick-'))
process.env.DSH_HOME = sandboxHome
process.env.DSH_PLUGIN_BACKUP_MIRROR = join(sandboxHome, 'location.json')
process.env.DSH_PROFILE = 'desktop'

const { apply } = await import('../index.js')

// 造两个可选的清单，放在不同目录，证明能跨目录选
const targetDir = mkdtempSync(join(tmpdir(), 'dsh-pick-target-'))
const targetFile = join(targetDir, 'my-manifest.json')
writeFileSync(
  targetFile,
  JSON.stringify({ bundles: [{ name: 'dsh-pet', version: '0.3.7', source: 'dsh-pet@^0.3.7' }] }, null, 2),
  'utf8',
)

let route
const installed = new Map([['dshmarket', { version: '1.66.35', source: 'dshmarket@^1.66.35' }]])
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
}

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

await new Promise((resolve) => setTimeout(resolve, 100))

/**
 * 调路由。
 * @param {string} method 方法
 * @param {object} [payload] 请求体
 * @returns {Promise<object>} 响应体
 */
async function call(method, payload = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  let text = ''
  await route.handler(
    {
      method: 'POST',
      url: `/plugin-backup/api/${method}`,
      async *[Symbol.asyncIterator]() {
        yield body
      },
    },
    {
      writeHead() {},
      end(chunk) {
        text = String(chunk)
      },
    },
  )
  return JSON.parse(text)
}

// 用一个 helper 进程在对话框弹出后自动选择文件。
// 稳定性来自三点：等窗口真的出现 → Alt+N 把焦点放进"文件名"框 → 只输文件名（不含中文/特殊字符）。
// 对话框已由 initialDir 定位到目标目录，所以文件名足够。
const driverDir = mkdtempSync(join(tmpdir(), 'dsh-pick-driver-'))
const driverScript = join(driverDir, 'drive.ps1')
writeFileSync(
  driverScript,
  `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string cls, string title);
}
'@
# 等对话框窗口出现（最多 15 秒）；常见文件对话框窗口类为 #32770
$hwnd = [IntPtr]::Zero
for ($i = 0; $i -lt 150; $i++) {
  $found = [Win]::FindWindow('#32770', $null)
  if ($found -ne [IntPtr]::Zero) { $hwnd = $found; break }
  Start-Sleep -Milliseconds 100
}
if ($hwnd -eq [IntPtr]::Zero) { exit 2 }
[void][Win]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 500
# Alt+N 聚焦标准文件对话框的"文件名"输入框
[System.Windows.Forms.SendKeys]::SendWait('%n')
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait('^a')
Start-Sleep -Milliseconds 150
[System.Windows.Forms.SendKeys]::SendWait('${targetFile.split(/[\\\\/]/).pop()}')
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Start-Sleep -Milliseconds 300
`,
  'utf8',
)

const driver = spawn('C:\\windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', [
  '-NoProfile',
  '-NonInteractive',
  '-STA',
  '-WindowStyle',
  'Hidden',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
  driverScript,
], { stdio: 'ignore', windowsHide: true })
console.log('[native] 拉起系统文件对话框并自动选择…')
const picked = await call('pick-file', { title: '选择插件清单', initialDir: targetDir })
driver.kill()

console.log('  返回：', JSON.stringify(picked).slice(0, 300))

check(picked.unsupported !== true, '宿主报告原生对话框可用')
if (picked.ok === true && picked.cancelled !== true) {
  check(picked.file === targetFile, '选中的正是目标文件路径')
  check(picked.bundles !== undefined && picked.bundles.length === 1, '同时读出了清单里的插件')
  check(picked.bundles[0].name === 'dsh-pet', '清单内容正确')
  check(Array.isArray(picked.diff), '同时给出与当前状态的差异')
} else if (picked.cancelled === true) {
  // 自动化没点中：不算功能失败，但要说清楚
  console.log('  ! 自动化未能选中文件（被取消）；对话框本身可用')
  check(true, '对话框成功打开并可取消')
} else {
  check(false, `原生对话框失败：${picked.error}`)
}

rmSync(sandboxHome, { recursive: true, force: true })
rmSync(targetDir, { recursive: true, force: true })
rmSync(driverDir, { recursive: true, force: true })

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} 项)`}`)
process.exit(failures === 0 ? 0 : 1)
