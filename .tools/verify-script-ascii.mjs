/**
 * 断言对话框脚本是纯 ASCII —— Windows PowerShell 5.1 按系统 ANSI 代码页读 .ps1，
 * 脚本里有中文会把脚本解析坏掉（表现为对话框弹出但从不返回结果）。
 *
 * 用法：node .tools/verify-script-ascii.mjs
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

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const start = source.indexOf('const NATIVE_DIALOG_SCRIPT')
check(start >= 0, '找到对话框脚本常量')

const openTick = source.indexOf('`', start) + 1
const closeTick = source.indexOf('`', openTick)
const script = source.slice(openTick, closeTick)

console.log(`  脚本长度 ${script.length} 字符`)
check(script.length > 200, '脚本非空')

const offenders = []
for (const [index, char] of [...script].entries()) {
  if (char.charCodeAt(0) > 127) offenders.push({ index, char, code: char.charCodeAt(0) })
}
check(offenders.length === 0, '脚本是纯 ASCII（PowerShell 5.1 的 ANSI 解析要求）')
if (offenders.length > 0) console.log('  非 ASCII 字符：', JSON.stringify(offenders.slice(0, 8)))

check(script.includes('OpenFileDialog'), '用 .NET 的 OpenFileDialog（系统原生文件对话框）')
check(!/PickFolders|PICKFOLDERS/i.test(script), '没有误用"只选文件夹"的选项')
check(script.includes('READY'), '有就绪握手，避免宿主误判')
check(script.includes('DSH_PICK_OUT'), '结果经 UTF-8 文件回传（中文路径不乱码）')
check(script.includes("Filter = 'Plugin manifest (*.json)|*.json"), '对话框过滤器默认只列 .json')

// 写脚本时加 BOM，是 5.1 识别 UTF-8 的唯一可靠方式
check(source.includes('\\uFEFF'), '写 .ps1 时加了 UTF-8 BOM')

// 中文标题必须走环境变量，不能写进脚本
check(script.includes('$env:DSH_PICK_TITLE'), '标题经环境变量传入（脚本内无中文）')

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} 项)`}`)
process.exit(failures === 0 ? 0 : 1)
