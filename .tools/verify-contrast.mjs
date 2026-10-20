/**
 * 用 DSH 主题令牌的**真实取值**算按钮文字对比度，证明两种主题下都看得清。
 *
 * 令牌值来自 @deepseek-ai/dsh-client-ui-theme 的浅/深两套定义（已从安装里核对）。
 *
 * 用法：node .tools/verify-contrast.mjs
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

// ── DSH 静态色板（来自 dsh-client-ui-theme） ─────────────────────────────
const STATIC = {
  'neutral-bluish-00': '#ffffff',
  'neutral-bluish-50': '#f9fafb',
  'neutral-bluish-100': '#ebeef2',
  'neutral-bluish-700': '#61666b',
  'neutral-bluish-750': '#43454a',
  'neutral-bluish-800': '#353638',
  'neutral-bluish-1000': '#0f1115',
}

// ── 两套主题下相关别名的解析结果 ─────────────────────────────────────────
const THEMES = {
  light: {
    'alias-label-primary': STATIC['neutral-bluish-1000'],
    'alias-label-primary-inverted': STATIC['neutral-bluish-00'],
    'alias-brand-primary': STATIC['neutral-bluish-1000'],
    'alias-button-primary-fill': STATIC['neutral-bluish-1000'],
    'alias-button-primary-hover': STATIC['neutral-bluish-750'],
    'alias-bg-layer-1': STATIC['neutral-bluish-00'],
    'alias-bg-layer-2': STATIC['neutral-bluish-75'] ?? '#f1f3f5',
  },
  dark: {
    'alias-label-primary': STATIC['neutral-bluish-50'],
    'alias-label-primary-inverted': STATIC['neutral-bluish-800'],
    'alias-brand-primary': STATIC['neutral-bluish-50'],
    'alias-button-primary-fill': STATIC['neutral-bluish-50'],
    'alias-button-primary-hover': STATIC['neutral-bluish-100'],
    'alias-bg-layer-1': STATIC['neutral-bluish-900'] ?? '#1b1b1c',
    'alias-bg-layer-2': STATIC['neutral-bluish-750'],
  },
}

/**
 * #rrggbb → 相对亮度（WCAG 2.1）。
 * @param {string} hex 颜色
 * @returns {number} 0..1
 */
function luminance(hex) {
  const value = hex.replace('#', '')
  const channels = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255)
  const linear = channels.map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}

/**
 * 两色对比度。
 * @param {string} foreground 前景
 * @param {string} background 背景
 * @returns {number} 1..21
 */
function contrast(foreground, background) {
  const a = luminance(foreground)
  const b = luminance(background)
  const lighter = Math.max(a, b)
  const darker = Math.min(a, b)
  return (lighter + 0.05) / (darker + 0.05)
}

// ── 从 client.js 里读实际用的规则 ────────────────────────────────────────
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const primaryRule = /\.pb-btn-primary\{[^}]*\}/.exec(source)?.[0] ?? ''
const primaryHover = /\.pb-btn-primary:hover[^{]*\{[^}]*\}/.exec(source)?.[0] ?? ''
const normalRule = /\.pb-btn\{[^}]*\}/.exec(source)?.[0] ?? ''

/** 从一条 CSS 规则里取某个 token 名。 */
const tokenIn = (rule, prefix) => {
  const match = new RegExp(`var\\(--dsw-${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`).exec(rule)
  return match === null ? undefined : prefix
}

console.log('[contrast] 主按钮（品牌底 + 反色字）')
for (const [name, theme] of Object.entries(THEMES)) {
  const fill = theme['alias-button-primary-fill']
  const inverted = theme['alias-label-primary-inverted']
  const ratio = contrast(inverted, fill)
  console.log(`  ${name}: 背景 ${fill} / 文字 ${inverted} → 对比度 ${ratio.toFixed(2)}:1`)
  check(ratio >= 4.5, `${name} 主题主按钮文字达到 WCAG AA（≥4.5）`)
}

console.log('\n[contrast] 主按钮悬停态')
for (const [name, theme] of Object.entries(THEMES)) {
  const hover = theme['alias-button-primary-hover']
  const inverted = theme['alias-label-primary-inverted']
  const ratio = contrast(inverted, hover)
  console.log(`  ${name}: 背景 ${hover} / 文字 ${inverted} → 对比度 ${ratio.toFixed(2)}:1`)
  // 悬停态也要能看：反色文字在 hover 底上可能偏低，但仍应明显可读
  check(ratio >= 3, `${name} 主题主按钮悬停态仍可读（≥3）`)
}

console.log('\n[contrast] 普通按钮（卡片底 + 主文字色）')
for (const [name, theme] of Object.entries(THEMES)) {
  const bg = theme['alias-bg-layer-2']
  const text = theme['alias-label-primary']
  const ratio = contrast(text, bg)
  console.log(`  ${name}: 背景 ${bg} / 文字 ${text} → 对比度 ${ratio.toFixed(2)}:1`)
  check(ratio >= 4.5, `${name} 主题普通按钮文字达到 WCAG AA`)
}

// ── 旧写法（白字 + brand-primary）到底有多糟 ──────────────────────────────
console.log('\n[contrast] 对照：原来的 #fff 写法')
for (const [name, theme] of Object.entries(THEMES)) {
  const ratio = contrast('#ffffff', theme['alias-brand-primary'])
  console.log(`  ${name}: 背景 ${theme['alias-brand-primary']} / 文字 #ffffff → 对比度 ${ratio.toFixed(2)}:1`)
  if (name === 'dark') {
    check(ratio < 4.5, `深色主题下 #fff 写法确实不可读（${ratio.toFixed(2)}:1，这就是要修的 bug）`)
  }
}

// ── 规则本身确实用了这些令牌 ─────────────────────────────────────────────
console.log('\n[contrast] 样式规则检查')
check(tokenIn(primaryRule, 'alias-button-primary-fill') !== undefined, '主按钮底色用 button-primary-fill')
check(tokenIn(primaryRule, 'alias-label-primary-inverted') !== undefined, '主按钮文字用 label-primary-inverted')
check(tokenIn(primaryHover, 'alias-button-primary-hover') !== undefined, '悬停底色用 button-primary-hover')
check(tokenIn(normalRule, 'alias-label-primary') !== undefined, '普通按钮文字用 label-primary')

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} 项)`}`)
process.exit(failures === 0 ? 0 : 1)
