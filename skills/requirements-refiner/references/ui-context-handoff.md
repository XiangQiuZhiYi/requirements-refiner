# UI 上下文缓存与交接

## 1. 双层快照

MasterGo 资料同时保存两层：

- `_sources/UI-xx-*.md`：按业务主题整理的可读证据，用于需求引用和审核。
- `_sources/raw/UI-xx/`：完整、冻结的机器快照，用于后续技术方案和开发，不直接放入审核上下文。

原始缓存结构：

```text
_sources/raw/UI-01/
├── manifest.json
├── section-index.json
├── source-map.json
├── design-sections-list.json.gz
└── sections.jsonl.gz
```

不得用摘要代替完整缓存。脚本把完整分区净化、最小化后合并为 gzip JSONL，避免数百个格式化 JSON 形成十几万行工作区变更。不得把 MCP 返回的 `fetchProgress`、重复操作说明、代码生成提示、认证字段或密钥写入缓存；保留根元数据、分区元数据、完整 DSL、文本、布局、组件状态、设计 token、资源引用和稳定节点 ID。

## 2. 抓取时落盘

1. 获取分区清单后初始化缓存，写入原始 URL、`fileId`、`layerId`、格式和期望分区数；使用 `put-list` 压缩保存分区清单。
2. 每个分区成功返回后立即执行 `put`。脚本只把净化、最小化后的单行内容写入并发安全的暂存文件，不依赖对话上下文保存数据。
3. 所有分区完成后执行 `finalize`，合并为 `sections.jsonl.gz`，生成归档与分区哈希，并删除逐分区暂存文件。
4. 建立规范化 `UI-01-Sxxx` 来源片段时，同步执行 `map`，映射实际分区和稳定节点。所有被正式需求引用的 UI 来源片段都必须有映射。
5. 运行 `status`；只有分区完整且至少有一个来源片段映射时，交接状态才是 `developmentReady: true`。空映射不得宣称已经可以按需求交给开发。
6. 失败分区重试后仍缺失时保留 `partial`，不得标记 `complete`。

使用标准库脚本：

```bash
node <skill-dir>/scripts/ui-context-cache.mjs init <需求包目录> --source UI-01 --source-url <URL> --file-id <ID> --layer-id <ID> --expected-sections <N> --format json
node <skill-dir>/scripts/ui-context-cache.mjs put-list <需求包目录> --source UI-01 --input <分区清单响应文件>
node <skill-dir>/scripts/ui-context-cache.mjs put <需求包目录> --source UI-01 --section <INDEX> --input <响应文件>
node <skill-dir>/scripts/ui-context-cache.mjs map <需求包目录> --source UI-01 --fragment UI-01-S001 --sections 1,2 --nodes 7:1,7:2 --title <业务主题>
node <skill-dir>/scripts/ui-context-cache.mjs finalize <需求包目录> --source UI-01
node <skill-dir>/scripts/ui-context-cache.mjs status <需求包目录>
```

历史逐文件缓存可以原地迁移，`compact` 会读取 `sections/`、净化并生成 v2 压缩归档，校验成功后才删除旧分区文件：

```bash
node <skill-dir>/scripts/ui-context-cache.mjs compact <需求包目录> --source UI-01
```

历史需求已经获取 UI 但未保存完整返回值时，使用 `mark-missing` 如实登记；不得根据摘要重建伪造 DSL，也不得未经用户要求自动重新抓取。

## 3. 后续开发按需读取

需求包根目录的 `requirement-package.json` 是机器交接入口。后续工作先检查对应 `sourceArtifacts[].developmentReady`，再读 `requirement-index.json`，通过需求来源片段找到相关 UI 分区：

```bash
node <skill-dir>/scripts/extract-ui-context.mjs <需求包目录> --source UI-01 --fragments UI-01-S003
```

提取脚本兼容 v1 逐文件缓存和 v2 gzip 缓存。不得默认把完整归档加载进模型上下文；脚本可以在本地解压归档，但只输出本次功能关联的分区。只有缓存缺失、校验失败，或用户明确要求同步最新设计时才重新访问 MasterGo。更新远端资料时先生成新版本和差异，不覆盖审核时冻结的快照。

## 4. 负荷控制

- 原始缓存不进入 npm/插件包，只属于每个需求资料包。
- 校验器只读取 manifest、索引和压缩归档哈希，不解析全部 DSL 语义；提取器只输出命中的分区。
- 无论原始体积大小，默认都使用 gzip JSONL；项目可以忽略二进制缓存，团队共享时再接入 Git LFS 或内部对象存储，`requirement-package.json` 入口保持稳定。
- 不为每次用户审核答复复制 UI；同一来源版本只保留一份冻结快照。
