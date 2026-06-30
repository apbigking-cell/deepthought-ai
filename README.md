# 深念 DeepThought

DeepSeek驱动的仿人脑**类人智能体**。不是被动的问答机器人，而是一个持续运行、会实时思考、有情绪和目标的"真人"：空闲时也在心里想事情，工作型人格能像工程师一样自主写代码、跑命令、推进自己的项目；社交型人格则以思考、情绪和主动陪聊为主。

v0.3.0 — 认知循环：实时思考(意识流) + 目标能动性 + 自主工作 + 长上下文

> 深者，DeepSeek之深，深层记忆之深；念者，念念不忘，每段记忆都是对自我的思念。

## 核心理念

- **持续意识流**：不依赖外部消息，空闲时也会按节律产生内心独白（默认模式网络），念念相连形成连续的"自我"
- **认知循环**：感知 → 情绪评估 → 思考(DeepSeek推理=内心独白) → 决策 → 行动 → 反思编码
- **能动性**：自己设立目标/项目，跨多个心跳分段推进，像人一样工作
- **自主工作**：工作型人格可自主读写代码、跑shell命令、查资料（沙箱+审批保护）
- **每人格独立心智**：每个人格有自己独立的情绪、意识流、目标，互不串味
- **长上下文**：利用 DeepSeek V4 Pro 1M 上下文，喂入完整意识流+长时间线+项目全貌，而非压缩碎片
- **心跳生命感**：每秒一次心跳（1Hz Tick）维持"活着"，微睡眠期做记忆巩固/压缩/遗忘/叙事
- **多层记忆**：L0感觉 → L1工作 → L2情景 → L3语义 → L4程序 → L5元 + L6人格

## 项目结构

```
fangnaojiyi/
├── src/
│   ├── index.js                    # 主入口
│   ├── config.js                   # 配置管理
│   ├── heartbeat/
│   │   └── orchestrator.js         # 1Hz心跳编排器（双相运行）
│   ├── state/
│   │   └── internal-state.js       # VAD情绪模型 + 驱动力引擎
│   ├── memory/                     # 6层记忆系统
│   │   ├── sensory.js              # L0 感觉缓冲
│   │   ├── working.js              # L1 工作记忆
│   │   ├── episodic.js             # L2 情景记忆
│   │   ├── semantic.js             # L3 语义记忆
│   │   ├── procedural.js           # L4 程序记忆
│   │   └── meta.js                 # L5 元记忆
│   ├── agents/                     # 12个智能体
│   │   ├── perception.js           # 感知
│   │   ├── encoding.js             # 编码
│   │   ├── retrieval.js            # 检索（分层：首轮WM→[RECALL:]触发深度检索）
│   │   ├── response.js             # 响应（人格+工具感知）
│   │   ├── central-exec.js         # 中央执行
│   │   ├── consolidation.js        # 巩固
│   │   ├── compression.js          # 压缩
│   │   ├── forgetting.js           # 遗忘
│   │   ├── association.js          # 关联
│   │   ├── metamemory.js           # 元记忆
│   │   ├── prospective.js          # 前瞻记忆
│   │   └── narrative.js            # 叙事（更新人物动态状态）
│   ├── cognition/                  # 认知系统（v0.3 新增）
│   │   ├── mind.js                 # 每人格心智：VAD情绪+意识流缓冲+注意力
│   │   ├── cognitive-cycle.js      # 认知循环：感知→评估→思考→决策→行动→反思
│   │   ├── scheduler.js            # 思考调度（反应式/自发式节律）
│   │   ├── goals.js                # 目标与能动性（目标/项目/意图/进度）
│   │   ├── work-agent.js           # 自主工作闭环（时间盒化多步工具循环）
│   │   └── context-assembler.js    # 大上下文组装（利用1M）
│   ├── codemap/                    # 分层可缩放代码依赖图谱（v0.3 编程强化）
│   │   ├── anchors.js              # 锚点规范（HTML注释界定可CRUD的md区块）
│   │   ├── md-doc.js               # md区块数据库（像数据库一样精准操作md，不破坏结构）
│   │   ├── extractors/             # 静态依赖提取（语言注册表）
│   │   │   ├── index.js            # 语言→extractor注册表
│   │   │   └── js.js               # JS/TS(acorn解析+正则降级)：import/export/方法/调用边
│   │   ├── graph-store.js          # 分层文件组织 + .codemap.json机器索引
│   │   ├── builder.js              # 扫描项目→按复杂度定层数→生成分层md
│   │   ├── updater.js              # 增量更新：仅精准改变更区块，结构变化才动上层
│   │   ├── context-agent.js        # CodeContextAgent：逐层放大取紧凑上下文(LLM只选ID)
│   │   └── tools.js                # codemap_build/query/zoom 工具
│   ├── persona/                    # 人格系统
│   │   ├── manager.js              # 旧单例（向后兼容）
│   │   ├── registry.js             # 多人格注册表（按persona_id隔离）
│   │   ├── context.js              # 单人格上下文（含自主等级）
│   │   └── router.js               # 人格路由
│   ├── tools/                      # 技能工具系统
│   │   ├── registry.js             # 工具注册表
│   │   ├── executor.js             # LLM工具执行循环
│   │   ├── approval.js             # 高危操作审批队列
│   │   └── builtin/
│   │       ├── calculator.js       # 计算器
│   │       ├── time.js             # 时间查询
│   │       ├── file.js             # 文件读写
│   │       ├── web.js              # HTTP请求
│   │       ├── shell.js            # shell命令（沙箱+审批）
│   │       └── (codemap工具见 src/codemap/tools.js)
│   ├── mcp/                        # MCP集成
│   │   ├── manager.js              # 多服务器管理
│   │   ├── bridge.js               # MCP→ToolRegistry桥接
│   │   └── transports/
│   │       └── stdio.js            # JSON-RPC over stdio
│   ├── terminal/
│   │   └── controller.js           # 终端命令（中英双语）
│   ├── bot/
│   │   ├── qq.js                   # QQ官方机器人 WebSocket
│   │   └── weixin.js               # 微信 iLink Bot 长轮询
│   ├── llm/
│   │   └── deepseek.js             # DeepSeek V4 Pro客户端
│   ├── db/
│   │   └── sqlite.js               # SQLite (sql.js WASM)
│   └── utils/
│       └── sentiment.js            # 轻量中文情感分析
├── data/
│   ├── persona-linxia.seed.json    # 林夏人格种子
│   └── personas/
│       ├── worker-zhang.seed.json  # 张工（专业/全工具）
│       └── worker-li.seed.json     # 李助研（专业/受限工具）
```

## 终端命令

| 中文 | English | 功能 |
|------|---------|------|
| `/人格列表` | `/personas` | 列出所有人格 |
| `/人格 <id>` | `/persona <id>` | 切换人格 |
| `/人格 注册 <seed>` | `/persona register <seed>` | 注册新人格 |
| `/人格 绑定 <平台> <uid> <pid>` | `/persona assign ...` | 绑定用户人格 |
| `/工具` | `/tools` | 列出工具 |
| `/mcp 状态` | `/mcp status` | MCP状态 |
| `/mcp 连接` | `/mcp connect` | 连接MCP |
| `/状态` | `/stats` | 引擎统计 |
| `/情绪` | `/mood [人格]` | 当前情绪+念头 |
| `/意识流` | `/think [人格]` | 内心独白 |
| `/目标` | `/goals [人格]` | 目标进展 |
| `/批准` | `/approve [id]` | 查看/批准待执行命令 |
| `/记忆` | `/mem` | 工作记忆 |
| `/qq` | — | 连接QQ |
| `/weixin` | — | 微信扫码登录 |

## 启动

```bash
npm install
# 编辑 .env 填入API Key和Bot凭证
npm start            # 纯终端
npm start -- --webui # 带 Web 管理面板（http://localhost:3000）
```

### Web 管理面板

- **在线聊天**：直接接入完整认知管线——可选择和哪个人格对话，对方会真实地感知→思考→决策→回复，气泡上可展开查看「内心独白」；工作型人格还能在对话里直接写代码（带代码块渲染）
- **心智页**：实时查看每个人格的情绪、意识流（内心独白）、目标进展、待批准的高危操作（一键批准/拒绝）
- **仪表盘**：心跳、思考循环、念头数、完成工作、记忆等统计；情景/工作记忆浏览
- **配置**：人格注册、AI 参数、QQ/微信、技能与 MCP 动态管理

## 代码依赖图谱 CodeMap（强化编程能力）

工作型人格写代码时，不再"盲改"，而是先从一套**分层可缩放的代码依赖图谱**取上下文，改完自动增量维护图谱。核心目标：用最少的 DeepSeek token 让模型精准理解大项目的依赖关系。

- **分层可缩放**：`index.md`(L1 模块总览) → `modules/*.md`(L2 模块内文件依赖) → `files/*.md`(L3 文件详情+方法级调用连线)。层数按项目复杂度**动态**决定（小项目仅两层）。"放大"= 打开更深一层的小文档，每层都受字符预算约束，DeepSeek 只读需要的层。
- **DeepSeek 友好的 md 格式**：每个语义单元用 HTML 注释锚点 `<!-- @node ... -->` 包裹，连线用 mermaid。锚点在渲染中不可见、不破坏结构。
- **像数据库一样精准操作 md**（`md-doc.js`）：`getNode/upsertNode/removeNode/getField/setField/setEdges`，全部**区块级 in-place** 编辑，非托管正文原样保留，`validate()` 保证锚点配对与 mermaid 不被破坏。
- **静态分析提取**（`extractors/`）：JS/TS 用 acorn 精确解析 import/export、方法定义、方法级调用边；TS/解析失败自动正则降级。多语言可扩展。
- **增量更新**（`updater.js`）：文件变更→重跑 extractor→精准 upsert 对应区块；**仅当依赖/导出/模块归属变化才触碰上层 md**。全程本地无 LLM 输出。
- **CodeContextAgent**（`context-agent.js`）：读机器索引→LLM 只输出"要放大的节点ID"→按 ID 打开 L2/L3 区块 + 按行号截取真实代码→组装紧凑上下文，逐层放大控预算。无 LLM 时降级为关键词启发式，仍可用。
- **工具**：`codemap_build`(构建/刷新) / `codemap_query`(按任务取上下文或看总览) / `codemap_zoom`(放大某节点)。work 人格自动开放，`work-agent` 每步前自动取上下文、改完自动增量更新。

图谱落在每个项目目录下的 `.codemap/`（运行时生成，已 gitignore）。

## 技术栈

| 组件 | 选型 |
|------|------|
| 运行时 | Node.js 24+ ESM |
| AI API | DeepSeek V4 Pro (1M context, thinking mode, function calling) |
| 代码图谱 | acorn 静态分析 + 分层 Markdown(mermaid) + 锚点区块DB |
| 数据库 | SQLite via sql.js (WASM) |
| QQ接入 | QQ官方机器人 WebSocket API |
| 微信接入 | 微信 iLink Bot API 长轮询 |
| MCP | JSON-RPC over stdio |

## 人格系统

| 人格 | 类型 | 自主模式 | 特点 |
|------|------|------|------|
| 林夏 | 社交 | chat（陪伴） | 23岁女，ENFP，自由撰稿人，养橘猫豆包，温暖口语化 |
| 张工 | 专业 | work（自主写代码） | 34岁男，INTJ，资深工程师，高效直接，全工具权限+shell |
| 李助研 | 专业 | work（研究分析） | 28岁女，INFJ，研究分析师，细致洞察，只读工具权限 |

> 自主模式 `work` 的人格可在沙箱里自主写代码/跑命令/推进项目；`chat` 模式以思考+情绪+主动陪聊为主。在人格种子JSON里用 `"autonomy_mode": "work"|"chat"` 配置。

## 脑科学对应

| 脑区/机制 | 引擎实现 |
|-----------|---------|
| 海马体齿状回 | EncodingAgent（模式分离） |
| 海马体CA3 | RetrievalAgent（模式补全） |
| 前额叶 | WorkingMemory + CentralExecutive |
| 杏仁核 | InternalState.emotionLabel |
| 颞叶皮层 | SemanticMemory |
| 基底节/小脑 | ProceduralMemory |
| 默认模式网络 | NarrativeAgent + 自发意识流（CognitiveCycle） |
| 内心独白/思考 | CognitiveCycle.THINK（DeepSeek推理内容） |
| 执行控制/决策 | CognitiveCycle.DECIDE（speak/work/recall/...） |
| 意图与目标导向行为 | GoalStore + WorkAgent |
| 突触缩放 | ForgettingAgent |
