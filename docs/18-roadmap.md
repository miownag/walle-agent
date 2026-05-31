# 18 — Roadmap

## 修正后的实现路线

原方案将自进化放在第四阶段，但自进化是 Walle 的核心卖点。修正后的路线将其提前到 Phase 2。

---

## Phase 1: Core Runtime（MVP 基础）

**目标**：能稳定跑 Tool Call + Streaming，具备插件扩展能力。

**时间**：2-3 周

```
核心包：@walle-agent/core
├── Agent + AgentRuntime
├── 执行循环（streaming-aware，AsyncGenerator 架构）
├── EventBus（typed events）
├── ToolRegistry + Tool 接口
├── LLMProvider 接口（chat + stream）
├── Hooks + HookManager
├── Middleware + MiddlewarePipeline
├── TokenBudget（基础版）
├── PromptBuilder
├── WallePlugin 接口
└── ContentBlock 多模态消息格式

Provider 包：
├── @walle-agent/openai（含 stream 支持）
├── @walle-agent/anthropic（含 stream + thinking 支持）
```

**验收标准**：
- [ ] `agent.run("hello")` 返回正确结果
- [ ] `agent.run("hello", { stream: true })` 返回流式事件
- [ ] Tool Call 正确执行并回灌
- [ ] Hooks 在正确时机触发
- [ ] Middleware 能修改输入/输出
- [ ] OpenAI、Anthropic 都能跑通
- [ ] 插件注册机制工作正常

---

## Phase 2: Memory + Evolution（核心差异化）

**目标**：具备自进化能力——记忆沉淀 + Skill 提取。

**时间**：2-3 周

```
记忆包：@walle-agent/memory  ✅（Memory slice 已落地）
├── MemoryManager                       ✅
├── SessionLog (JSONL append-only)      ✅ file-backed short-term memory
├── ToolResultVault                     ✅ 大 tool result 外溢
├── FileMemoryStore (JSONL)             ✅ long-term memory
├── 记忆检索（关键词 + Jaccard）         ✅
├── 记忆去重                            ✅
├── remember / recall / forget tools    ✅
├── collect_context 事件集成            ✅
└── collect_messages 事件集成           ✅ 跨 run 回放 history

技能包：@walle-agent/skills  ✅（Skills slice 已落地）
├── SkillRegistry                       ✅
├── SkillFileStore (JSON)               ✅
├── Skill 检索（关键词+置信度）          ✅
└── collect_context 事件集成            ✅

进化包：@walle-agent/evolution  ✅（Evolution slice 已落地）
├── EvolutionEngine                     ✅
├── 显式 Remember 检测                  ✅
├── 周期性 Review（每 N 轮）            ✅
├── 任务复盘 → Skill 提取               ✅
├── Memory/Skill Proposal 类型          ✅
├── ProposalFileStore（审批队列）        ✅
└── 审批回调接口                        ✅
```

**验收标准**：
- [x] 用户说"记住 X"→ 通过 `remember` 工具自动写入长期记忆
- [x] 每 10 轮对话自动 review 并提取记忆（Evolution 分支）
- [x] 复杂任务后自动生成 Skill Proposal（Evolution 分支）
- [x] 下次相关查询时，记忆自动注入 prompt（`collect_context`）
- [x] 会话历史跨 run 自动回放（`collect_messages` + `messages.jsonl`）
- [x] 大 tool result 自动外溢，下一轮看到摘要 + 文件引用
- [x] 取消后继续的 run 会完整重放被中断那次的 tool result
- [x] Proposal 可以持久化等待审批（Evolution 分支）
- [x] TokenBudget 正确裁剪过多的上下文

---

## Phase 3: MCP + Sandbox + Permissions

**目标**：支持外部工具生态和安全执行。

**时间**：2 周

```
MCP 包：@walle-agent/mcp  ✅（MCP slice 已落地）
├── MCPClientManager                     ✅
├── stdio transport                      ✅
├── Streamable HTTP transport            ✅
├── 工具白名单/黑名单                     ✅
└── MCP tool → internal Tool 适配        ✅

沙箱包：@walle-agent/sandbox
├── Sandbox 接口
├── LocalSandbox (execa)
├── DockerSandbox
└── shell tool 注册

权限：@walle-agent/permissions（或内置 core）
├── PermissionPolicy
├── 风险等级检查
├── 审批回调
└── 白名单/黑名单
```

**验收标准**：
- [x] MCP stdio server 的工具能被 Agent 调用
- [x] MCP HTTP server 工具能被调用
- [x] 高风险工具触发权限检查
- [x] Sandbox 中执行 shell 命令并返回结果
- [x] 工具超时正确处理

---

## Phase 4: Team & Collaboration

**目标**：多 Agent 协作能力。

**时间**：2 周

```
协作包：@walle-agent/team  ✅（Team slice 已落地）
├── AgentTeam                      ✅ parallel / pipeline / debate / supervisor
├── SubAgent Tool                  ✅ createSubAgentTool（auto-slugify name）
├── createSupervisorTeam helper   ✅ 显式传 model 构建带 delegate tools 的 coordinator
├── Swarm + SwarmPolicy            ✅
├── Blackboard                     ✅
└── Coordinator 接口               ✅（接口预留，未在当前策略中消费）
```

**验收标准**：
- [x] Pipeline 模式：Research → Code → Review 流水线执行
- [x] Parallel 模式：多 Agent 并行执行并汇总
- [x] Supervisor 模式：Coordinator 动态分配子任务
- [x] SubAgent 封装为 Tool 可被调用

---

## Phase 5: RAG + Trace + Polish

**目标**：补全生态，可观测性。

**时间**：1-2 周

```
RAG 包：@walle-agent/rag  ✅（RAG slice 已落地）
├── RAGPlugin 接口                      ✅
├── SimpleRAGPlugin（文件分块+关键词检索） ✅ 自动 collect_context 注入
├── ingest / delete / list 完整实现     ✅
└── (外部) @walle-agent/rag-qdrant      ⏭ deferred

Trace 包：@walle-agent/trace  ✅（Trace slice 已落地）
├── TracePlugin                        ✅ 订阅 EventBus 全量事件
├── JSONLTraceStore                    ✅ 按日期分文件 append
├── InMemoryTraceStore                 ✅ 环形缓冲，可设 maxSize
├── customStore 注入点（用户自带 OTEL）  ✅
└── (外部) @walle-agent/trace-otel      ⏭ deferred

Polish：
├── 完善 error handling               ✅ Trace 写入失败不 crash agent
├── 完善 TypeScript 类型导出           ✅ 所有 plugin 包都从 index.ts 导出
├── API 文档生成（TypeDoc）            ⏭ deferred
├── examples/ 补全                    ✅ rag.ts / trace.ts 已就位
└── README + 使用指南                  ⏭ deferred
```

**验收标准**：
- [x] `SimpleRAGPlugin` 加载文件 → 注入到 system prompt
- [x] `TracePlugin` 记录 run / model_call / tool_call / context_collect 事件
- [x] JSONL 存储读写正确，跨日期分文件
- [x] 内存存储正确执行 maxSize 淘汰
- [x] 全量测试 321 passing

---

## Phase 6: Advanced Evolution（后续迭代）

```
Offline Evolution：
├── Trace 分析 → 评估数据集生成
├── Prompt 变体生成 + 评估
├── Skill 自动优化
├── 工具描述优化
└── 人工审批 + 自动 PR

Memory 增强：
├── Embedding-based 检索（需向量存储）
├── Memory 自动过期/衰减
├── Memory 冲突解决
└── 跨 session 记忆共享

Skill 增强：
├── Workflow Skill 执行引擎
├── Code Skill + Sandbox 执行
├── Skill 版本管理
├── Skill 自动废弃（低使用率 + 低成功率）
└── Embedding-based Skill 检索
```

---

## 里程碑总览

```
Week 1-3:   Phase 1 (Core Runtime)
              → 可以跑通 Agent + Tool + Stream
Week 4-6:   Phase 2 (Memory + Evolution)
              → MVP 发布，核心差异化能力就位
Week 7-8:   Phase 3 (MCP + Sandbox + Permissions)
              → 对接外部工具生态
Week 9-10:  Phase 4 (Team)
              → 多 Agent 协作
Week 11-12: Phase 5 (RAG + Trace + Polish)
              → 生产可用，文档完善
Week 13+:   Phase 6 (Advanced)
              → 持续迭代
```

---

## 技术栈确认

| 类别 | 选型 |
|------|------|
| 语言 | TypeScript 5.x, ESM |
| 运行时 | Node.js 20+ |
| 包管理 | pnpm workspace |
| 构建 | tsup (esbuild-based) |
| 测试 | vitest |
| Lint | eslint + prettier |
| CI | GitHub Actions |
| 发布 | changesets |
| 文档 | TypeDoc + 手写 guides |

---

## 非目标（明确排除）

1. **浏览器兼容**：不做，Node.js only
2. **UI 框架**：不提供 UI，只是 SDK
3. **部署平台**：不内置部署能力，用户自行部署
4. **模型训练/微调**：不涉及
5. **数据库 ORM**：不内置，FileStore 为默认
