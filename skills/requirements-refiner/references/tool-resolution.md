# MCP 工具能力解析

## 1. 不绑定服务器名称

不同用户可以把同一 MCP 配置成不同名称。不要依赖 `mcp__yuque__`、`mcp__schoolpal__` 等服务器命名空间，也不要要求用户为了本技能重命名 MCP。

按以下逻辑能力寻找工具：

| 能力 | 首选工具尾名 | 必需 |
|---|---|---|
| 语雀大纲 | `yuque_get_doc_outline` | 是 |
| 语雀文档包 | `yuque_export_docs_bundle` | 是 |
| 语雀单篇 Markdown | `yuque_get_doc_markdown_by_url` | 否 |
| MasterGo 分区 | `mastergo_getDesignSections` | 是 |
| MasterGo 完整 DSL | `mastergo_getDsl` | 否，回退使用 |

优先按工具尾名精确匹配，其次使用工具描述中的 Yuque、MasterGo、outline、section、DSL 等能力词。运行 `scripts/resolve-mcp-tools.mjs` 可以校验一份工具清单。

## 2. 歧义与缺失

- 一个能力只有一个高置信度匹配时直接使用。
- 同一能力出现多个同等级匹配时，只询问用户选择哪一组，不逐个询问工具。
- 优先选用能同时提供同类完整能力的同一服务器。
- 缺少可选工具时使用已有回退，不阻塞流程。
- 缺少必需能力时说明缺少的逻辑能力，不输出或要求固定 MCP 名称。

工具映射属于每个用户的运行环境，不写入需求包。若宿主提供插件数据目录，可把用户确认的映射缓存在插件数据目录；不得提交到项目仓库。
