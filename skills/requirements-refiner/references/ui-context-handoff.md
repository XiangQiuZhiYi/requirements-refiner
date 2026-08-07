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
└── sections/
    ├── 0000.json
    └── ...
```

不得用摘要代替完整缓存，也不得把 MCP 返回的重复操作说明、代码生成提示或密钥写入缓存。保留根元数据、分区元数据、完整 DSL、文本、布局、组件状态、设计 token、资源引用和稳定节点 ID。

## 2. 抓取时落盘

1. 获取分区清单后初始化缓存，写入原始 URL、`fileId`、`layerId`、格式和期望分区数。
2. 每个分区成功返回后立即原样保存，不等全部读取完再依赖对话上下文回收数据。
3. 所有分区完成后执行 `finalize`，生成每个文件的大小和 SHA-256。
4. 根据规范化来源片段生成 `source-map.json`，把 `UI-01-S003` 映射到实际分区和节点。
5. 失败分区重试后仍缺失时保留 `partial`，不得标记 `complete`。

使用标准库脚本：

```bash
node <skill-dir>/scripts/ui-context-cache.mjs init <需求包目录> --source UI-01 --source-url <URL> --file-id <ID> --layer-id <ID> --expected-sections <N> --format json
node <skill-dir>/scripts/ui-context-cache.mjs put <需求包目录> --source UI-01 --section <INDEX> --input <响应文件>
node <skill-dir>/scripts/ui-context-cache.mjs map <需求包目录> --source UI-01 --fragment UI-01-S001 --sections 1,2 --nodes 7:1,7:2
node <skill-dir>/scripts/ui-context-cache.mjs finalize <需求包目录> --source UI-01
```

历史需求已经获取 UI 但未保存完整返回值时，使用 `mark-missing` 如实登记；不得根据摘要重建伪造 DSL，也不得未经用户要求自动重新抓取。

## 3. 后续开发按需读取

需求包根目录的 `requirement-package.json` 是机器交接入口。后续工作先读该文件和 `requirement-index.json`，再通过需求来源片段找到相关 UI 分区：

```bash
node <skill-dir>/scripts/extract-ui-context.mjs <需求包目录> --source UI-01 --fragments UI-01-S003
```

不得默认加载全部 UI 缓存。只有缓存缺失、校验失败，或用户明确要求同步最新设计时才重新访问 MasterGo。更新远端资料时先生成差异，不覆盖审核时冻结的快照。

## 4. 负荷控制

- 原始缓存不进入 npm/插件包，只属于每个需求资料包。
- 校验器只读取 manifest、索引和文件哈希，不解析全部 DSL 语义。
- 单份缓存小于 20 MB 时保留普通文件；更大时可在后续版本增加 gzip、Git LFS 或内部对象存储，交接清单路径保持不变。
- 不为每次用户审核答复复制 UI；同一来源版本只保留一份冻结快照。
