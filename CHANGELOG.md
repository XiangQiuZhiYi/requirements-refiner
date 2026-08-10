# Changelog

## 0.1.5

- 对话审核改为严格按 UC 顺序推进，进入 UC 时先展示完整功能清单，再集中处理确认问题。
- `reviewPlan` 增加每个 UC 的功能、未解决问题和自动确认就绪状态。
- 当前 UC 的问题全部解决且没有修改、疑问或同步漂移时，支持自动将剩余功能点设为“理解一致”；用户主动要求待确认时不会自动完成。

## 0.1.4

- UI 原始缓存升级为 gzip JSONL，避免数百个格式化 JSON 造成十几万行工作区变更。
- 缓存时自动移除 `fetchProgress`、重复 MCP 操作提示和认证字段，保留完整设计 DSL。
- 增加旧逐文件缓存的 `compact` 迁移、压缩分区清单和 v1/v2 按需提取兼容。
- `requirement-package.json` 增加 UI 存储方式、映射数量和 `developmentReady` 交接状态。

## 0.1.3

- 参考 `one-click-repair` 的分发方式，将完整 Plugin 原子安装到 `$CODEX_HOME/requirements-refiner/marketplace`，默认即 `~/.codex/requirements-refiner/marketplace`。
- 自动发现 PATH、Codex Desktop、VS Code、VS Code Insiders、Cursor、Windsurf 和 VSCodium 内置的 Codex CLI，不要求单独安装全局命令。
- 一次命令完成 Marketplace 注册、Plugin 安装和安装结果校验。
- 自动迁移 0.1.2 创建的 `~/.agents` 独立 Skill；存在本地修改时先备份，不直接删除。
- 更新失败时恢复上一版稳定 Plugin 文件和原 Marketplace 注册。

## 0.1.2

- 默认安装为 `~/.agents/skills/requirements-refiner` 用户级独立 Skill，同时支持 Codex 桌面端、CLI 和 VS Code IDE 扩展。
- 正常安装、更新和诊断不再依赖 `codex` 命令，修复仅安装 VS Code 扩展时的 `spawn codex ENOENT`。
- 更新时可自动发现 Codex App 或 IDE 扩展内置 CLI，并尽力清理 0.1.1 及更早版本创建的 Marketplace。
- 增加受管目录、内容指纹和 `--force` 保护，避免覆盖用户自行维护的同名 Skill。
- 移除误加入的包自依赖和无效 `main` 入口。

## 0.1.0

- 将需求收集与审核原型转换为 Codex 插件。
- 增加 npm 一键安装、更新、诊断和安全卸载命令。
- 保留动态 MCP 能力匹配与 UI 上下文缓存交接能力。
