# Requirements Refiner

面向 Codex 的需求收集与审核插件。它将语雀需求文档、MasterGo 设计资料和用户补充整理为可追溯的 Markdown 需求包，并通过对话引导用户逐步审核。

## 安装

发布后运行：

```bash
npx requirements-refiner@latest
```

安装器会先展示将写入的位置和将执行的 Codex 命令，得到确认后再创建独立 Marketplace 并安装插件。安装完成后新建 Codex 任务，输入：

```text
使用 $requirements-refiner 检查需求整理环境。
```

安装器不会配置或重命名 MCP。只要当前 Codex 环境提供匹配的语雀和 MasterGo 工具能力，Skill 就会按能力发现并调用。

## 管理命令

```bash
npx requirements-refiner@latest update
npx requirements-refiner@latest doctor
npx requirements-refiner@latest uninstall
```

所有命令支持 `--json` 和 `--codex-home <path>`；会产生修改的命令还支持 `--yes` 与 `--dry-run`。

卸载只删除本安装器管理的插件与 Marketplace，不删除项目中的 `docs/requirements`、`_sources` 或 UI 原始缓存。

## 开发校验

```bash
npm test
npm run validate
npm run test:pack
npm run release:check
```

首次公开发布必须单独检查 npm scope 权限和 tarball 内容，然后由发布者明确执行 `npm publish --access public`。

## 数据边界

npm 包只包含通用 Skill、规则、模板与标准库脚本。每次需求产生的正文、来源快照和 UI 上下文都保存在使用者当前项目中，通过 `requirement-package.json` 交给后续开发流程，不进入 npm 包。
