# Requirements Refiner

用于 Codex 的需求收集、整理与审核 Plugin。

它读取语雀需求文档、MasterGo 设计资料和用户补充，将分散信息整理为可追溯的 Markdown 需求包，并通过对话引导用户逐步确认功能点和待确认问题。整理完成的需求与 UI 上下文可以直接交给后续技术方案和开发流程使用。

## 能做什么

- 整合一个或多个语雀需求文档。
- 整合一个或多个 MasterGo 设计链接。
- 支持用户补充截图、需求名称、阶段和规则说明。
- 仅在来源或用户明确标注 UC 时拆分 UC，不根据页面结构自行推测。
- 生成详细需求、公共需求、UC 引导和总需求引导。
- 标记来源冲突、信息缺失和 AI 推断，避免把推断当作正式需求。
- 通过“开始审核”“继续审核”逐步主持功能点审核。
- 审核严格按 UC 顺序推进：先列出当前 UC 的全部功能，再集中回答确认问题；问题全部解决后自动确认该 UC。
- 把完整 UI 上下文保存为压缩快照，并建立需求片段映射，供后续开发按需读取，无需重复拉取设计资料。

本 Plugin 只负责需求收集、补全和审核，不生成技术方案，不分析代码，也不会开始功能开发。

## 环境要求

- Node.js 20 或更高版本。
- npm。
- Codex 桌面端、Codex CLI 或 VS Code 中的 Codex 扩展，任选其一。
- 当前 Codex 环境中已配置可读取资料的 MCP 工具。

Plugin 不要求固定的 MCP 服务器名称。只要工具能力能够匹配语雀大纲、语雀正文导出、MasterGo 分区读取等能力即可。

不要求系统 PATH 中存在 `codex` 命令。安装器会自动搜索 Codex Desktop，以及 VS Code、VS Code Insiders、Cursor、Windsurf 和 VSCodium 中 Codex 扩展自带的 CLI。

## 安装

```bash
npx requirements-refiner@latest
```

安装器会依次：

1. 检查 Node.js 版本和 npm 包内 Plugin 是否完整。
2. 展示将写入的 `$CODEX_HOME` 稳定目录和 Plugin 名称。
3. 等待用户确认。
4. 自动发现终端、Codex Desktop 或 IDE 扩展内置的 Codex CLI。
5. 将完整 Plugin 原子复制到 `~/.codex/requirements-refiner/marketplace/`。
6. 注册 `requirements-refiner` Marketplace，并安装或更新 Plugin。
7. 校验安装版本，然后迁移 0.1.2 独立 Skill 和更早版本的 Marketplace。

安装完成后，请完全退出并重新打开 Codex，使新安装的 Plugin 被加载。

## 第一次使用

先检查当前 Codex 会话能够识别哪些资料工具：

```text
使用 $requirements-refiner 检查需求整理环境。
```

检查只报告工具能力，不修改 MCP 配置，也不会创建需求文件。

确认环境后，可以直接提供需求资料：

```text
使用 $requirements-refiner 整理下面的需求：

语雀需求文档：https://example.yuque.com/xxx
MasterGo 设计图：https://mastergo.com/file/xxx
需求名称：预约规则优化
阶段：一期
```

文档生成后开始审核：

```text
开始审核
```

后续可以使用：

```text
继续审核
查看审核进度
UC02 除功能点 3 外全部理解一致
功能点 3 需要修改：默认值改为 0
```

审核结果会写回需求文档，不只保存在聊天上下文中。

## 生成内容

需求资料默认生成在当前项目：

```text
docs/requirements/<需求名称>/<阶段>/
```

单体需求：

```text
00-需求引导.md
01-详细需求.md
requirement-index.json
requirement-package.json
_sources/
```

明确包含多个 UC 时：

```text
00-需求引导.md
01-公共需求.md
UC01-名称/
├── 需求引导.md
└── 详细需求.md
UC02-名称/
├── 需求引导.md
└── 详细需求.md
requirement-index.json
requirement-package.json
_sources/
```

其中：

- `00-需求引导.md`：用于快速理解整体需求和审核重点。
- `详细需求.md`：需求事实来源，保存字段、规则、状态、异常和验收标准。
- `requirement-index.json`：需求编号、审核状态、问题和定位索引。
- `requirement-package.json`：后续技术方案和开发读取需求包的统一入口。
- `_sources/`：语雀、MasterGo 和用户补充的来源快照。
- `_sources/raw/UI-xx/`：完整 UI 压缩上下文、分区索引和需求片段映射。

## UI 上下文交接

MasterGo 数据会在首次获取时净化并压缩为 `_sources/raw/UI-xx/sections.jsonl.gz`，同时通过 `source-map.json` 和 `requirement-package.json` 建立交接入口。数百个设计分区不会再以格式化 JSON 分散写入工作区。

`requirement-package.json` 中的 `sourceArtifacts[].developmentReady` 表示该 UI 来源是否同时满足“分区抓取完整”和“已建立来源片段映射”。后续开发应优先读取已有缓存，并使用 Skill 内的 `extract-ui-context.mjs` 只提取当前功能关联的 UI 分区，不把完整归档放入模型上下文。

只有以下情况才需要重新访问 MasterGo：

- UI 缓存缺失。
- 缓存校验失败。
- 用户明确要求同步最新设计。

原始 UI 数据属于具体业务项目，不会进入 npm 插件包。

## 安装后写入的位置

默认使用：

```text
~/.codex/requirements-refiner/marketplace/
├── .agents/plugins/marketplace.json
├── .distribution.json
└── plugins/requirements-refiner/
    ├── .codex-plugin/plugin.json
    └── skills/requirements-refiner/
```

如果设置了 `CODEX_HOME`，稳定目录会写到 `$CODEX_HOME/requirements-refiner/marketplace/`。`.distribution.json` 保存版本、受管路径和内容指纹，用于安全更新、诊断和卸载。

0.1.2 曾安装到 `~/.agents/skills/requirements-refiner/`。升级时，如果确认它由本安装器创建且内容未修改，会自动清理；有本地修改时会先改名备份。

安装过程不会：

- 修改或创建 MCP 配置。
- 保存语雀或 MasterGo 凭证。
- 拉取任何业务需求或 UI 数据。
- 修改当前项目。
- 安装全局 npm 包。
- 启动后台服务。

## 管理命令

更新：

```bash
npx requirements-refiner@latest update
```

诊断：

```bash
npx requirements-refiner@latest doctor
```

卸载：

```bash
npx requirements-refiner@latest uninstall
```

卸载只移除本安装器管理的 Plugin、Marketplace 和稳定目录，不删除任何项目需求文档、来源快照或 UI 缓存。

通用选项：

| 参数 | 作用 |
| --- | --- |
| `--yes` | 跳过修改前确认，适合自动化环境 |
| `--force` | 明确覆盖或删除已被本地修改的受管 Plugin |
| `--dry-run` | 只检查并展示操作，不修改配置 |
| `--json` | 输出机器可读 JSON |
| `--codex-home <path>` | 覆盖默认的 `~/.codex` / `CODEX_HOME` |
| `--codex-bin <path>` | 指定 Codex CLI 的绝对路径 |
| `--agents-home <path>` | 指定 0.1.2 旧独立 Skill 所在的 `.agents` 根目录 |

## 开发与发布检查

```bash
npm test
npm run validate
npm run test:pack
npm run release:check
```

项目使用 Node.js 原生 ESM、Markdown 和 JSON，不需要编译，也不需要生成 `dist/`。npm 发布时会根据 `package.json` 中的 `files` 白名单直接生成 tarball。

公开发布前应单独确认 npm 包名、账号权限和 tarball 内容，再由发布者明确执行：

```bash
npm publish --access public
```

## 数据与发布边界

npm 包只包含通用插件声明、Skill、规则、模板和标准库脚本，不包含：

- 实际业务需求文档。
- 语雀或 MasterGo 凭证。
- UI 原始缓存。
- `_sources` 来源快照。
- 安装器测试和发布测试。

当前包使用 `UNLICENSED`，用于授权的内部评估和使用。
