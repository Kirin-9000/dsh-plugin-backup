<p align="center">
  <img src="icon.svg" width="96" alt="dsh-plugin-backup icon">
</p>

# dsh-plugin-backup

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![stars](https://img.shields.io/github/stars/Kirin-9000/dsh-plugin-backup?style=flat)](https://github.com/Kirin-9000/dsh-plugin-backup)

DeepSeek Harness（DSH）的插件备份与恢复插件。DSH 更新有可能重置整个 `.dsh`——插件、配置、连同放在里面的备份一起消失。dsh-plugin-backup 把已安装插件清单持久化到 **`.dsh` 之外**的可配置目录，更新之后对比差异、勾选、一键恢复全部历史插件，不必逐个重新下载。

> 🛡️ **恢复只走 Harness 官方插件安装接口**（`pluginManager.installBundle` / `removeBundle` / `setBundleEnabled` / `setPluginEnabled`），安装动作必须由你在界面上确认后才执行；插件绝不代批安装脚本，也绝不凭版本号猜测安装来源。清单与日志只写本机磁盘，不上传任何位置。

## 它解决什么问题

DSH 把已安装插件记录在 profile 目录里。一次 Harness 更新可能：

- 清掉 profile 里装过的全部插件，逐个重找重装；
- 插件还在但版本被悄悄换掉，行为和你说好的不一样；
- 插件还在但被禁用，得一个个翻出来重新打开。

把插件清单备份到 `.dsh` 里解决不了问题——**备份和要被备份的东西在同一个篮子里**。这个插件做三件事：

1. **备份**：把当前 profile 已安装的插件（包名、精确版本、安装来源 spec、每个插件行的启用状态）写成可读 JSON，落在 profile 目录之外；
2. **检测**：Harness 更新后对比「备份 vs 当前」，列出五类差异：

   | 差异 | 含义 |
   | --- | --- |
   | `missing` | 备份里有，现在完全没装 |
   | `version-mismatch` | 装了，但版本和备份不同 |
   | `disabled` | 装了，但整个 bundle 被禁用 |
   | `row-disabled` | bundle 在，个别插件行被禁用 |
   | `row-missing` | 该插件行在当前 profile 里不存在 |

3. **恢复**：在界面上勾选后一键恢复，逐项执行、实时进度、失败记录日志后继续，不中断批次。

## 安装

**方式一：dsh 命令行**（`web` 等 CLI 管理的 profile）

```sh
dsh plugin --profile web add git+https://github.com/Kirin-9000/dsh-plugin-backup.git
```

profile 不叫 `web` 就把名字换掉。重启或刷新后，打开 **设置 → 插件 → 「备份与恢复」**。

**方式二：官方 DSH Desktop 桌面端**

桌面端的 profile 归应用自己的插件管理器所有，应用运行期间命令行改不了它。请在应用自身的 **设置 → 插件** 里安装；或用方式三以开发方式接入。

**方式三：开发 / 本地接入**

```sh
git clone https://github.com/Kirin-9000/dsh-plugin-backup.git
# 把仓库链接进 profile 的 node_modules（Windows 需要管理员或开发者模式的符号链接权限）
mklink /D "<DSH_HOME>\profiles\<profile>\node_modules\dsh-plugin-backup" "<克隆路径>\dsh-plugin-backup"
```

源码改动即时生效（Host 半侧由 HMR 感知，Client 半侧刷新页面即可），适合改代码验证。

## 你会得到

- **启动自动备份**——DSH 启动约 5 秒后采集一次清单；清单没变且快照不足一天时自动跳过，避免刷屏。手动「立即备份」随时可用，快照按时间戳保留最多 20 份，超出自动清理最旧的。
- **一键恢复**——差异默认全选，可逐项勾选；恢复前二次确认，逐个插件执行并实时显示进度。幂等：每一步先读当前真实状态，已满足就跳过；`already-installed` 时按官方插件页同样的两步法（先移除再安装）。重复点恢复不会产生重复安装。
- **已备份的插件清单本体**——即使当前一切正常、没有任何差异，备份里到底有哪些插件、备份时什么版本、现在什么状态、几个插件行，一页看全。没有安装来源的插件明确标出「无安装来源，需手工安装」，而不是恢复时报一个误导性的 not-found。
- **备份位置可配置**——把备份目录指到 `.dsh` 之外的任意位置（本地盘、移动硬盘均可）；保存前真实写探测文件验证可写，不可写直接拒绝。位置指针双写（`.dsh` 正式记录 + 用户主目录镜像），`.dsh` 被重置后靠镜像找回目录（见下文）。
- **从任意 JSON 清单恢复**——不限于备份目录里的 `latest.json`：移动硬盘 / 网盘里的旧备份、自己手写的最小清单 `[{"name":..., "version":...}]` 都能直接按它恢复，且不改变当前备份位置。
- **系统原生文件对话框**——「选择文件…」打开的是熟悉的系统「打开」窗口：自由切换盘符、进「此电脑」、用收藏夹，默认只列 `.json`。非 Windows / 无 PowerShell 时自动退回内置的 `.json` 文件浏览器（子目录可进、面包屑可回跳）。
- **精确版本恢复**——注册表包钉到备份时的精确版本（`包名@版本`），保证「恢复成原来那份」而不是悄悄升到 latest；git / tarball / 本地目录来源按原样重装。
- **`plugin_backup` 智能体工具**——对 Agent 暴露只读的 `status`（位置 + 已备份清单 + 差异）与 `backup`（落一份新快照），支持可选参数 `file` 读指定清单。**恢复是安装包的动作，只保留为用户在界面上的显式操作**，工具不会安装任何东西。
- **完整日志**——每次备份、恢复、单项结果都追加在备份目录的 `log.jsonl`，界面可随时查看最近记录。
- **零依赖**——只用 Node 内置模块和宿主提供的 `pluginManager` / `webServer` / `tools` 服务，不 require 任何 Harness Client 包，降低 DSH 版本差异导致的加载失败风险。

## 怎么用

安装后打开 **设置 → 插件 → 「备份与恢复」**，从上到下：

| 区块 | 内容 |
| --- | --- |
| 顶部 | 上次备份时间、插件数量、当前安装数量、备份目录；「立即备份」「刷新」 |
| 备份存储位置 | 查看与切换备份目录（建议指到 `.dsh` 之外） |
| 从指定 JSON 文件恢复 | 填路径或点「选择文件…」读取任意一份清单，按它恢复 |
| 已备份的插件 | 快照里的完整插件清单：名称、备份版本、当前状态、行数、能否自动恢复 |
| 检测到的差异 | 只有出问题的项，逐个带说明；勾选后「恢复所选」 |
| 恢复进度 / 日志 | 实时进度、逐项成功/失败结果、最近日志 |

## 把备份放到 .dsh 之外（重要）

默认清单放在 `$DSH_HOME/plugin-backup/`。Harness 更新有可能重置整个 `.dsh`，所以**建议把备份目录指到别的地方**：

1. **界面**——「备份存储位置」→「更改位置」→ 填一个新目录（如 `D:\dsh-backups`）→「保存位置」；
2. **环境变量**——设 `DSH_PLUGIN_BACKUP_DIR=D:\dsh-backups` 后重启 DSH，优先级最高。

生效优先级：`DSH_PLUGIN_BACKUP_DIR` > `.dsh` 里的 settings.json > 主目录镜像 > 默认目录。

### 位置指针本身也会被重置，所以存两份

| 文件 | 作用 |
| --- | --- |
| `$DSH_HOME/plugin-backup/settings.json` | 正式记录 |
| `~/.dsh-plugin-backup-location.json` | 主目录镜像，**`.dsh` 被重置后靠它找回目录** |

界面看到来源标为「自定义（靠主目录镜像找回）」时，说明 `.dsh` 被重置过：备份没丢，点一次「保存位置」把正式记录补回去即可。

## 从指定 JSON 文件恢复

文件不必在备份目录里，名字也不必叫 `latest.json`。接受两种格式：

- 标准快照 `{ "bundles": [ ... ] }`；
- 直接一个插件数组 `[ { "name": "...", "version": "..." } ]`。

每条只需 `name`；`version` 决定重装到哪个版本，`source` 决定从哪儿装（缺 `source` 会标「无安装来源」）。选定后自动读取并预览（不落盘、不改设置），确认清单和差异后再「恢复所选」。坏文件（不存在 / 不是 JSON / 缺 `bundles` / 传了目录）都会明确报错，不会静默失败。

> **为什么不用 Harness 自带的选择器**：它的 `directoryPicker` 走 Win32 COM `IFileOpenDialog`，但把 options 硬编码成 `104`（`FOS_PICKFOLDERS | FORCEFILESYSTEM | PATHMUSTEXIST`），只能选文件夹。所以插件在独立 PowerShell 子进程里拉起同一个系统对话框（.NET `OpenFileDialog`）去掉 PICKFOLDERS，得到标准文件选择。脚本纯 ASCII + UTF-8 BOM（Windows PowerShell 5.1 的解析约束），选中的路径经 UTF-8 文件回传避免中文路径乱码。

## 快照格式

```json
{
  "schemaVersion": 1,
  "createdAt": "2026-10-20T06:12:19.508Z",
  "dshVersion": "0.2.1-rc.2",
  "profile": "desktop",
  "bundles": [
    {
      "name": "dsh-better-sidebar",
      "version": "0.28.0",
      "source": "dsh-better-sidebar@^0.28.0",
      "enabled": true,
      "rows": [
        { "rowId": "better-sidebar", "moduleName": "dsh-better-sidebar", "entryId": "include:better-sidebar", "enabled": true }
      ]
    }
  ]
}
```

- `schemaVersion` 变了说明字段结构有调整，读取方按版本兼容；
- `source` 是 pnpm 记录的依赖值；`installTarget`（官方目录条目才有）优先于它；
- 手动修清单后可以直接重新恢复——这是刻意设计的「用户可修正」通道。

## 安全与边界

- **只用官方安装接口**，不做任何非官方注入；不记录、不上传任何数据，清单与日志只写本机磁盘；
- **恢复必须用户确认**：Host 不会自行安装任何东西；确认界面列出全部将处理的插件；
- **不代批安装脚本**：遇到 `pendingBuilds` 会停下来，提示你去「设置 → 插件」自行确认；
- **没有安装来源就不猜**：`source` 缺失时不会凭版本号拼 `包名@版本` 去装——那会把本机自建 / 手工放置的包当成 npm 包，报出误导性的失败；这种情况明确提示交给你手工处理；
- **不记录 DSH 安装自带的 bundle**（`availability: 'installation'`）：它们随 DSH 升级自己会回来；
- **失败不中断**：任一项失败只记日志并继续下一项，结束给出成功 / 失败汇总；
- **只写自己的文件**：备份目录、`.dsh/plugin-backup/settings.json`、`~/.dsh-plugin-backup-location.json`；不修改 `package.json` / `cordis.patch.yml`；
- **同源围栏**：HTTP 路由复用宿主自己的 `connection.requestRejection` 来源校验，任意网页无法触发本机插件安装。

## HTTP 接口

浏览器半侧使用（都是同源 POST + JSON）：

| 方法 | 作用 |
| --- | --- |
| `status` | 位置信息 + 已备份清单 + 当前安装 + 差异 + 恢复进度 + 日志；可选 `{ sourceFile }` |
| `backup` | 立即备份到当前目录 |
| `restore` | 按勾选恢复；可选 `{ sourceFile }` 从指定清单恢复 |
| `settings` | 无参读取位置；`{ backupDir }` 改位置（空串 = 恢复默认） |
| `load-file` | 只读预览一份指定清单 `{ file }`，不落盘不改设置 |
| `pick-file` | 拉起系统原生文件对话框选 `.json`；不支持时回 `unsupported` |
| `list-files` | 列目录供内置浏览器用 `{ dir }`；只回 `.json` 文件与子目录 |
| `log` | 最近日志 |

## 排障

| 现象 | 处理 |
| --- | --- |
| 差异里某插件没有「安装来源」 | 该条 `source` / `version` 都缺；手工装上后在界面点「立即备份」刷新清单 |
| 恢复提示「安装脚本待批准」 | 去「设置 → 插件」批准该包的 build script，再回来重试 |
| 恢复提示「与当前 DSH 版本不兼容」 | 该插件版本不支持当前 DSH；等插件更新，或在插件页显式授予版本豁免 |
| 恢复后提示「重启后生效」 | `restart-required` 属正常：该包替换了已加载模块，重启 DSH 后生效 |
| 想恢复某个已删掉的插件 | 快照里还留着它——只要没超过 20 份快照的保留窗口，勾上恢复即可 |
| DSH 更新后面板显示默认目录 | `.dsh` 被重置过；若主目录镜像还在会显示「靠主目录镜像找回」，点一次「保存位置」补回正式记录 |

## 开发

```text
index.js            宿主半侧：清单采集 / 位置配置 / 差异计算 / 恢复编排 / HTTP 路由 / plugin_backup 工具
client.js           浏览器半侧：设置→插件里的「备份与恢复」页
cordis.patch.yml    bundle 行声明（id: plugin-backup）
locale/{en,zh}.json 插件列表里的标题与描述
icon.svg            插件图标
```

验证脚本（`node .tools/<name>.mjs`）：

| 脚本 | 覆盖 |
| --- | --- |
| `verify-host.mjs` | 宿主行为：备份 / 差异 / 恢复 / 两步法 / 改目录 / 指定文件 / 列目录 / 无 `.tmp` 残留，共 15 组 |
| `verify-client.mjs` | 浏览器半侧：模块注册、字典、槽位、面板渲染、原生 / 兜底两条选文件路径 |
| `verify-meta.mjs` | 展示元数据：locale / icon 可被宿主解析 |
| `verify-live.mjs` | 真实快照与 profile 现状的一致性 |
| `verify-external.mjs` | 外部目录 + `.dsh` 重置 + 指定文件恢复的端到端 |
| `verify-browse-live.mjs` | 内置浏览器读真实备份目录时看到的项 |
| `verify-script-ascii.mjs` | 原生对话框脚本纯 ASCII + BOM 编码约束 |
| `verify-native-picker.mjs` | 真拉起系统文件对话框并自动选中（会弹窗，需桌面会话） |
| `verify-contrast.mjs` | 按主题令牌真实取值计算按钮文字 WCAG 对比度 |

> 测试全部把 `DSH_HOME` 与 `DSH_PLUGIN_BACKUP_MIRROR` 指向临时目录，不会碰你真实的 `~/.dsh` 和主目录指针。

## 反馈

- Bug 与功能建议提 [issue](https://github.com/Kirin-9000/dsh-plugin-backup/issues)，附上备份目录里 `log.jsonl` 的相关片段能让排查快很多（注意先删掉其中的本地路径等敏感信息）。

## 许可

[MIT](LICENSE) © Kirin-9000
