# 父子智能体控制与进度协作实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Harness 实现 Codex 风格的父子智能体控制、进度报告、状态查询、生命周期关闭、客户端展示和可重复打包验收。

**Architecture:** 保持 `agent-loop` 通用，通过 `dsh-subagent` continuation service 暴露 queue、follow-up、steering、interrupt 和 close 五类生命周期操作。所有模型可见状态先进入 session event，再由工具、父级 inbox、SDK 通知和 Web 投影消费；`report` 继续作为 child 作用域能力，`code-pinned` 默认安装它。

**Tech Stack:** TypeScript ESM、Cordis、Vitest、SessionEventMap、Agent inbox、ACP keyless snapshots、SDK JSON-RPC、Web UI、GitHub Actions desktop workflow。

## Global Constraints

- 不在 `agent-loop` 增加子智能体专用分支；控制行为只能通过 Agent inbox、subagent service 和插件扩展点实现。
- `send_message` 只入队不唤醒；`followup_task` 入队并唤醒；`steer_agent` 在下一个安全 step 生效；`interrupt_agent` 只停止当前轮次并保留未领取 inbox；`close_agent` 以 child-first 顺序结束并释放目标子树。
- 所有跨会话 id 使用仓库的 branded `SessionId` / `MessageId`，不得在公共接口使用裸 `string` 表示持久 id。
- 父到子操作必须由服务依据确切在线 Agent 和持久化 lineage 鉴权；`list_agents` 和状态查询结果不能作为授权凭据。
- 模型可见的报告、状态、控制结果和通知必须可从 session log 重建；新增事件使用可忽略 envelope，只有结构性格式变化才评估 `SESSION_FORMAT_VERSION`。
- `wait_agent` 不声明静态 `ToolDefinition.timeoutMs`；deadline 只由 `timeout_ms` 和 `exec.signal` 控制。
- 不手工修改生成的工具目录；不提交现有未跟踪插件目录、`.npm_cache` 或 `src` 下生成的 `.js`、`.d.ts`、`.map` 文件。
- 每个非机械任务同时更新对应英文 README、中文 README、JSDoc、单元测试、真实组合测试和必要的 Agent Note。

---

## 文件结构

| 路径 | 职责 |
|---|---|
| `packages/subagent/subagent/src/types.ts` | 新增控制、状态、进度和关闭结果的公共类型。 |
| `packages/subagent/subagent/src/index.ts` | 在 `SubagentRuntime` Service Definition 上公开新增控制和查询方法。 |
| `packages/subagent/subagent/src/continuation.ts` | 实现 queue/follow-up/steer/interrupt/close 的授权、激活和释放事务。 |
| `packages/subagent/tool-subagent-control/src/index.ts` | 注册 `send_message`、`followup_task`、`steer_agent`、`interrupt_agent`、`close_agent`、`get_agent_status` 工具。 |
| `packages/subagent/tool-subagent-report/src/index.ts` | 保留 `report` 工具并安装默认阶段报告提示词。 |
| `packages/subagent/subagent/src/descriptor.ts` | 作为 subagent owning package 声明 `SessionEventMap` 的控制与进度事件。 |
| `packages/core/session/src/known-event-types.ts` | 由 persistence catalog 生成器更新已知事件类型。 |
| `docs/persistence-catalog.md` / `docs/persistence-catalog.zh.md` | 由 persistence catalog 生成器更新事件目录。 |
| `packages/sdk/protocol/src/types.ts` | 增加 `subagent.progress`、`subagent.report`、`subagent.control` 通知及 `subagent/control`、`subagent/status` JSON-RPC 请求类型。 |
| `packages/sdk/server/src/server.ts` | 将 session 事件和子智能体状态投影到 SDK 通知。 |
| `packages/sdk/client/src/client.ts` | 提供按根会话过滤的树订阅和状态缓存。 |
| `packages/client/ui-subagent/src/client/SubagentHeaderLineage.tsx` | 在已有子智能体树中显示状态、报告和控制菜单。 |
| `packages/client/ui-subagent/src/client/index.ts` | 将状态查询和控制动作注入子智能体 UI。 |
| `packages/client/ui-subagent/src/client/locales.ts` | 提供中英文控制标签、状态和错误文案。 |
| `packages/subagent/*/README{,.zh}.md` | 更新服务和工具契约、模型体验、限制和安全语义。 |
| `docs/subsystems/subagent{,.zh}.md` | 更新子系统参考和事件索引。 |
| `packages/core/tools/tests/gen-tool-catalog.spec.ts` | 更新工具名称和来源断言。 |
| `examples/acp-agent/tests/` 与 `packages/test-support/acp-snapshot/` | 增加父子控制真实组合与 keyless 快照。 |
| `.agents/notes/proposed/architecture/2026-08-31-parent-child-agent-control.{md,zh.md,i18n.yaml}` | 记录控制语义、状态事件和关闭事务的决策。 |
| `apps/cli/config/agent-presets/code/agent.cordis.yml` | 随客户端发布的 code preset，安装 `tool-subagent-report`、内置 Skill 根目录并更新可见工具配置。 |
| `apps/cli/config/agent-presets/code/skills/multi-agent-delivery/SKILL.md` | 随 shipped code preset 发布的主从调度纪律。 |
| `C:\Users\liuxu001\.dsh\.agent-presets\code-pinned\agent.cordis.yml` | 本机覆盖，仅用于开发验证，不进入 Git 或发布包。 |
| `C:\Users\liuxu001\.dsh\.agent-presets\code-pinned\skills\multi-agent-delivery\SKILL.md` | 本机覆盖的调度纪律；发布版本同步到 shipped preset 的 Skill 目录。 |

## Task 1: 定义服务接口和事件

**Files:**

- Modify: `packages/subagent/subagent/src/types.ts`
- Modify: `packages/subagent/subagent/src/index.ts`
- Modify: `packages/subagent/subagent/src/continuation.ts`
- Modify: `packages/subagent/subagent/src/descriptor.ts`
- Generated: `packages/core/session/src/known-event-types.ts`, `docs/persistence-catalog.md`, `docs/persistence-catalog.zh.md`
- Test: `packages/subagent/subagent/tests/continuation.spec.ts`

**Interfaces:**

- Produces: `SubagentMessageMode = 'queue' | 'followup' | 'steer'`、`SubagentCloseOptions`、`SubagentStatusSnapshot`、`SubagentControlResult`。
- Produces: `SubagentRuntime.queue()`、`followup()`、`steer()`、`interrupt()`、`close()`、`status()`。
- Consumes: 现有 `Agent.inbox`、`Agent.followup()`、`Agent.steer()`、`Agent.cancel()`、`AgentHandle.dispose()` 和父级 lineage。

```ts ignore-check
type SubagentMessageMode = 'queue' | 'followup' | 'steer'
type SubagentControlRequestId = Branded<'SubagentControlRequestId'>

interface SubagentControlResult {
  readonly requestId: SubagentControlRequestId
  readonly agentId: SessionId
  readonly accepted: boolean
  readonly messageId?: MessageId
}

interface SubagentRuntime {
  queue(parent: Agent, childId: SessionId, content: ContentBlock[], options: SubagentQueueOptions): Promise<SubagentControlResult>
  followup(parent: Agent, childId: SessionId, content: ContentBlock[], options: SubagentFollowupOptions): Promise<SubagentControlResult>
  steer(parent: Agent, childId: SessionId, content: ContentBlock[], options: SubagentSteerOptions): Promise<SubagentControlResult>
  interrupt(childId: SessionId, authority: SubagentInterruptAuthority): Promise<SubagentControlResult>
  close(childId: SessionId, authority: SubagentCloseAuthority, options?: SubagentCloseOptions): Promise<SubagentCloseResult>
  status(parent: Agent, childId: SessionId): Promise<SubagentStatusSnapshot>
}
```

`SubagentQueueOptions`、`SubagentFollowupOptions` 和 `SubagentSteerOptions` 是三个独立的公共类型；不能通过给同一个 options 类型增加可选字段来隐藏唤醒差异。`SubagentCloseAuthority` 独立于 `SubagentInterruptAuthority`，并且 close 结果包含 `closedAgentIds`、`previousState`、`accepted`、`noOp` 和 branded `requestId`。

- [ ] **Step 1: 写失败的公共类型和服务行为测试**

覆盖 direct parent、ancestor、self、sibling、stale Agent、unknown id 六种授权结果，并断言 `queue` 不唤醒、`followup` 唤醒、`steer` 在 next-step 入队、`interrupt` 保留 inbox、`close` 等待 child-first dispose。额外覆盖 cold child 的 queue→followup、进程重启后的持久 inbox 恢复、queue 与 close 并发、steer 与 disposal sentinel 并发，以及一次性/远程 provider 明确返回 capability-not-supported 而不伪造本地 Agent。

- [ ] **Step 2: 运行定向测试确认接口缺失**

Run: `pnpm exec vitest run packages/subagent/subagent/tests/continuation.spec.ts -t "queue|followup|steer|close"`

Expected: FAIL，报告缺少新增方法或结果类型。

- [ ] **Step 3: 实现最小服务接口和唯一关闭事务**

在 continuation manager 内复用现有 per-child lock。`queue()` 对 live child 只追加 inbox；对 cold child 在同一 child lock 内物化 Activation、追加持久 inbox 并保持 `waiting`，不启动 driver；`followup()` 再唤醒同一 Activation。`steer()` 接受 live 或已有 Activation 的 idle child；cold child 必须先由 `followup()` 物化并唤醒。`close()` 先同步设置 disposal sentinel，再取消目标和后代，清除未领取 queue/steering，等待所有释放 promise，最后发布关闭事件；未知或已完成目标返回幂等 no-op。重启恢复时，持久 inbox 中的 queue 消息必须先于 watcher 的 settled-child 清理逻辑被识别，且不会自动启动 driver。

- [ ] **Step 4: 运行定向测试和类型检查**

Run: `pnpm exec vitest run packages/subagent/subagent/tests/continuation.spec.ts`; `pnpm exec tsc -p packages/subagent/subagent/tsconfig.json --noEmit`

Expected: PASS；关闭重复调用共享同一个完成结果，未授权请求没有副作用。

- [ ] **Step 5: 生成 persistence catalog**

Run: `pnpm run gen-persistence-catalog`

Expected: 更新 `packages/core/session/src/known-event-types.ts` 和 `docs/persistence-catalog.md` / `docs/persistence-catalog.zh.md`，随后 `pnpm run verify-persistence-catalog` PASS。

- [ ] **Step 6: 提交服务接口**

```bash
git add packages/subagent/subagent/src/types.ts packages/subagent/subagent/src/index.ts packages/subagent/subagent/src/continuation.ts packages/subagent/subagent/src/descriptor.ts packages/subagent/subagent/tests/continuation.spec.ts packages/core/session/src/known-event-types.ts docs/persistence-catalog.md docs/persistence-catalog.zh.md
git diff --cached --check
git commit -m "feat(subagent): add parent child control operations"
```

## Task 2: 拆分消息与新增控制工具

**Files:**

- Modify: `packages/subagent/tool-subagent-control/src/index.ts`
- Modify: `packages/subagent/tool-subagent-control/tests/tool-subagent-control.spec.ts`

**Interfaces:**

- Consumes: Task 1 的 service methods。
- Produces: `send_message`、`followup_task`、`steer_agent`、`interrupt_agent`、`close_agent`、`get_agent_status` 六个模型工具。

- [ ] **Step 1: 为六个工具写 schema 和执行失败测试**

断言每个工具的参数、返回字段、未知目标错误、无 calling agent 错误、`steer_agent` 不接受 root、`close_agent` 默认 `cascade: true`。

- [ ] **Step 2: 运行工具测试确认失败**

Run: `pnpm exec vitest run packages/subagent/tool-subagent-control/tests/tool-subagent-control.spec.ts -t "followup_task|steer_agent|close_agent|get_agent_status"`

Expected: FAIL，工具 schema 尚未注册。

- [ ] **Step 3: 实现工具适配器**

每个执行器把 `exec.agent` 作为服务授权参数；`send_message` 调用 `queue()`，`followup_task` 调用 `followup()`，`steer_agent` 调用 `steer()`，`close_agent` 返回关闭事务完成后的 agent id 列表，`get_agent_status` 只返回状态快照。所有输出使用稳定短文本和结构化结果。

- [ ] **Step 4: 覆盖消息顺序、打断接管和关闭竞态**

测试顺序为 `interrupt_agent` → `steer_agent`，断言旧轮次不重放、steer 消息在下一 step 出现；并发 close/steer 断言 steer 在 disposal sentinel 后被拒绝。

- [ ] **Step 5: 运行包测试并提交**

Run: `pnpm exec vitest run packages/subagent/tool-subagent-control/tests/tool-subagent-control.spec.ts`; `pnpm run typecheck`

```bash
git add packages/subagent/tool-subagent-control
git diff --cached --check
git commit -m "feat(subagent): expose parent control tools"
```

## Task 3: 完成报告、状态事件和持久化投影

**Files:**

- Modify: `packages/subagent/tool-subagent-report/src/index.ts`
- Modify: `packages/subagent/tool-subagent-report/tests/tool-subagent-report.spec.ts`
- Modify: `packages/subagent/subagent/src/descriptor.ts`
- Modify: `packages/subagent/subagent/src/continuation.ts` 的状态投影实现
- Generated: `packages/core/session/src/known-event-types.ts`, `docs/persistence-catalog.md`, `docs/persistence-catalog.zh.md`
- Test: `packages/core/session/tests/gen-persistence-catalog.spec.ts`
- Test: `packages/subagent/subagent/tests/continuation.spec.ts`

**Interfaces:**

- Consumes: Task 1 的控制结果和现有 `reportFrom()`。
- Produces: log-only `subagent/progress`、`subagent/control` 事件以及可重放的 `SubagentStatusSnapshot`；报告正文仍只通过 parent `user/message` 进入模型历史，避免重复投影。

- [ ] **Step 1: 写事件 envelope 和重放失败测试**

每个事件断言 `agentId`、`parentSessionId`、branded `requestId` 或 `messageId`、单调 `eventSeq`、毫秒时间、状态和 `ignorable` 标记；重放后得到与在线查询相同的 `state`、`pendingMessageCount` 和最近报告。报告内容、phase 和 stop reason 使用 profile 配置的 UTF-8 字节上限，并覆盖空值、超限单块和多字节输入。

- [ ] **Step 2: 实现事件发布点**

只在消息被接受、报告被接受、控制请求被接受或 close 事务完成后发布事件；禁止在请求开始时提前更新完成状态。

- [ ] **Step 3: 增加状态查询投影**

状态由持久事件和目录描述符合并得到；缺失或损坏的描述符返回 diagnostic，不泄露原始内容；完整结果按 agent id 稳定排序。

- [ ] **Step 4: 运行 session 和 report 定向测试**

Run: `pnpm exec vitest run packages/subagent/tool-subagent-report/tests packages/subagent/subagent/tests packages/core/session/tests/gen-persistence-catalog.spec.ts -t "progress|report|replay|status"`

Expected: PASS；进程重启后状态和报告仍可恢复，重复报告不会伪造 child 结算。

- [ ] **Step 5: 提交事件与投影**

```bash
git add packages/subagent/tool-subagent-report packages/subagent/subagent packages/core/session/src/known-event-types.ts packages/core/session/tests/gen-persistence-catalog.spec.ts docs/persistence-catalog.md docs/persistence-catalog.zh.md
git diff --cached --check
git commit -m "feat(subagent): persist child progress and control events"
```

## Task 4: 更新 SDK 通知和 Web 控制面板

**Files:**

- Modify: `packages/sdk/protocol/src/types.ts`
- Modify: `packages/sdk/protocol/src/index.ts`
- Modify: `packages/sdk/server/src/server.ts`
- Modify: `packages/sdk/client/src/client.ts`
- Modify: `packages/sdk/client/src/api.ts`
- Modify: `packages/client/runtime/src/client/sessions/manager.ts`
- Modify: `packages/client/runtime/src/client/sessions/service.ts`
- Test: `packages/sdk/server/tests/server.spec.ts`
- Test: `packages/sdk/client/tests/sdk-client.spec.ts`
- Modify: `packages/client/ui-subagent/src/client/SubagentHeaderLineage.tsx`
- Modify: `packages/client/ui-subagent/src/client/index.ts`
- Modify: `packages/client/ui-subagent/src/client/locales.ts`
- Test: `apps/web/tests/subagent-interrupt-ui.e2e.ts` 及新增控制 e2e
- Test: `packages/client/runtime/tests/manager.client.spec.ts`
- Create: `apps/web/tests/subagent-parent-control-ui.e2e.ts`

**Interfaces:**

- Produces: `subagent.progress`、`subagent.report`、`subagent.control` 通知；`subagent/control` 和 `subagent/status` requests；`subscribeSessionTree()` 增量维护状态缓存。
- Consumes: Task 3 的 session events 和既有 `subagent.started` / `subagent.finished`。

- [ ] **Step 1: 为通知类型和乱序处理写失败测试**

注入重复、乱序、跨根会话通知，断言旧事件被丢弃、不同根会话互不污染、关闭通知覆盖 running 状态；调用 `subagent/control` 覆盖五种 action 的参数校验、parent session 鉴权、结构化错误和远程 capability-not-supported 错误。

- [ ] **Step 2: 实现协议投影和客户端缓存**

在 `HarnessSdkRequestMap` 增加 `subagent/control` 与 `subagent/status`，服务端从已打开 session 恢复确切 Agent 后调用 Task 1 的 service API；沿用现有 JSON-RPC notification transport，通知参数只携带事件中已验证的字段；客户端以 `eventSeq` 和时间戳维护每个 agent 的最后状态，并提供 `controlSubagent()` / `getSubagentStatus()` 方法。

- [ ] **Step 3: 添加 UI 操作菜单**

子智能体节点显示状态、阶段、最近报告、活动时间和待处理数量；菜单分别发起排队、插话、打断和关闭请求，并展示 request id 和服务确认结果。

- [ ] **Step 4: 运行 SDK 与 Web 定向检查**

Run: `pnpm exec vitest run packages/sdk/server/tests packages/sdk/client/tests`; `pnpm exec vitest run packages/client/ui-subagent/tests`; `pnpm exec vitest run apps/web/tests/subagent-interrupt-ui.e2e.ts`; `pnpm run typecheck`

Expected: PASS；UI 不使用乐观完成状态，刷新后从通知/事件恢复同一树状态。

- [ ] **Step 5: 提交 SDK 与 UI**

```bash
git add packages/sdk packages/client/ui-subagent
git diff --cached --check
git commit -m "feat(ui): expose parent child progress controls"
```

## Task 5: 更新预设、提示词、README 和目录

**Files:**

- Modify: `apps/cli/config/agent-presets/code/agent.cordis.yml`
- Create: `apps/cli/config/agent-presets/code/skills/multi-agent-delivery/SKILL.md`
- Verify only: `C:\Users\liuxu001\.dsh\.agent-presets\code-pinned\agent.cordis.yml`
- Verify only: `C:\Users\liuxu001\.dsh\.agent-presets\code-pinned\skills\multi-agent-delivery\SKILL.md`
- Modify: `packages/subagent/tool-subagent-control/README.md`
- Modify: `packages/subagent/tool-subagent-control/README.zh.md`
- Modify: `packages/subagent/tool-subagent-report/README.md`
- Modify: `packages/subagent/tool-subagent-report/README.zh.md`
- Modify: `packages/subagent/README.md`
- Modify: `packages/subagent/README.zh.md`
- Modify: `docs/subsystems/subagent.md`
- Modify: `docs/subsystems/subagent.zh.md`
- Modify: `packages/core/tools/tests/gen-tool-catalog.spec.ts`
- Generated: `docs/tool-catalog.md`, `docs/tool-catalog.zh.md`
- Create: `.agents/notes/proposed/architecture/2026-08-31-parent-child-agent-control.{md,zh.md,i18n.yaml}`

**Interfaces:**

- Consumes: Tasks 1–4 的模型工具、事件和客户端语义。
- Produces: `code-pinned` 默认可报告、可查询、可 steering、可中断和可关闭的主从 persona。

- [ ] **Step 1: 修改 code-pinned 预设**

在 shipped code preset 的 `tool-subagent` 行之后加入 `@deepseek-ai/dsh-tool-subagent-report`，并为 `skill-filesystem` 配置以 `baseUrl` 解析的 `skills/` 根目录；创建 `apps/cli/config/agent-presets/code/skills/multi-agent-delivery/SKILL.md`。在 shipped persona/Skill 中固定以下行为：先并行派发，按里程碑 report，结果依赖时 wait，`Wait completed.` 后结束当前 step；发现偏航时 interrupt 后 steer；无进展时查询状态而不是 busy polling。随后把同一内容复制到本机 `code-pinned` 覆盖用于黑盒验证；本机覆盖不进入 Git 或发布包。

- [ ] **Step 2: 更新 README 和 Agent Note**

写明 queue/follow-up/steer/interrupt/close 的差异、权限、持久化、报告限制和 UI 通知，不描述实现历史，不重复生成目录内容。

- [ ] **Step 3: 更新目录断言并重生成**

更新精确工具名称数组和来源映射，运行仓库目录生成器，禁止手工编辑生成区域。

- [ ] **Step 4: 运行文档和目录检查**

Run: `pnpm exec vitest run packages/core/tools/tests/gen-tool-catalog.spec.ts`; `pnpm run doc-sync`; `git diff --check`

Expected: PASS；README 的中英文结构一致，目录来源唯一且无重复注册错误。

- [ ] **Step 5: 提交文档与预设**

```bash
git add packages/subagent packages/core/tools/tests/gen-tool-catalog.spec.ts docs/tool-catalog.md docs/tool-catalog.zh.md docs/subsystems .agents/notes/proposed/architecture apps/cli/config/agent-presets/code
git diff --cached --check
git commit -m "docs(subagent): document parent child control workflow"
```

Git 提交包含 `apps/cli/config/agent-presets/code` 的 shipped preset；用户目录中的覆盖不加入 Git 提交，但必须在发布前备份并通过实际客户端验证。

## Task 6: 增加真实组合、keyless 快照和 SDK 双端输出

**Files:**

- Modify: `examples/acp-agent/tests/acp.snapshot.ts`
- Create: `examples/acp-agent/code-mode-parent-child-control.cordis.yml`
- Create: `examples/acp-agent/code-mode-parent-child-control.cordis.snapshot.yml`
- Create: `examples/acp-agent/tests/fixtures/code-mode-parent-child-control-fence.ts`
- Create: `examples/acp-agent/tests/snapshots/code-mode-parent-child-control/`
- Modify: `python/sdk/tests/` 中对应 expected output
- Modify: `scripts/snapshots/python-sdk-single-exe/` 中对应 expected output
- Modify: `packages/sdk/client/tests/fake-runtime.ts`

**Interfaces:**

- Consumes: Tasks 1–5 的完整 Loader composition。
- Produces: 可重放的并行派发、report、状态查询、steer、interrupt、close 和结算 transcript。

- [ ] **Step 1: 编写确定性 parent/child fence**

固定两个 child 的启动顺序；第一个 child report 后暂停，第二个 child 进入错误状态；父级查询状态后 steering 第一个、关闭第二个，再等待两个结算通知。

- [ ] **Step 2: 先运行 keyless snapshot 确认缺少快照**

Run: `pnpm run test:snapshot -- -t code-mode-parent-child-control`

Expected: FAIL，指出缺少 fixture 或 expected 输出。

- [ ] **Step 3: 生成并审阅 keyless expected 输出**

Run: `pnpm run test:snapshot:record -- -t code-mode-parent-child-control`（仅在确定性 provider 可用时）

Expected: 输出包含工具 schema、persona、报告消息、状态事件和控制结果，且不包含真实 API key 或平台路径。

- [ ] **Step 4: 更新 TypeScript 和 Python SDK expected output**

同步记录 `subagent.started`、`subagent.progress`、`subagent.control`、`subagent.report`、`subagent.finished` 的字段和顺序。

- [ ] **Step 5: 运行快照与双 SDK 检查**

Run: `pnpm run test:snapshot -- -t code-mode-parent-child-control`; `pnpm exec vitest run packages/sdk/client/tests`; `pnpm run typecheck`

Expected: PASS；重放两次产生完全相同的模型可见消息和事件顺序。

## Task 7: 构建、打包和发布验收

**Files:**

- Modify only if required: `apps/desktop/` packaging configuration and release metadata
- Test: `scripts/release/desktop-portable.spec.ts`
- Test: `scripts/release/desktop-runtime.spec.ts`

**Interfaces:**

- Consumes: Tasks 1–6 的源代码、预设、构建产物和快照。
- Produces: 带新工具和预设的 Windows portable、Android APK/AAB 及校验和。

- [ ] **Step 1: 执行最小发布前检查**

Run: 按 `.agents/skills/dsh-pre-push-checks/SKILL.md` 选择本次变更的定向检查（至少控制工具测试、SDK/UI 测试、keyless snapshot、`pnpm run typecheck`、`pnpm run doc-sync`、`pnpm run build`）；仅在发布候选阶段或 CI 诊断时运行 `pnpm run test` 和 `pnpm run hygiene`。

Expected: 全部 PASS；若有与本功能无关的既有失败，只记录并停止修复范围扩张。

- [ ] **Step 2: 构建桌面和移动端包**

通过仓库已有 GitHub Actions desktop workflow 生成 portable zip、`.sha256`、APK 和 AAB；不在本地提交构建产物。

- [ ] **Step 3: 安装包后执行黑盒验收**

在全新 Session 中确认工具目录包含六个控制工具和 `report`，启动两个 child，验证报告、状态查询、插话、打断后改道和关闭；检查重启后 child 状态可恢复。

- [ ] **Step 4: 校验并上传 artifact**

计算 zip 的 SHA-256，与 workflow 输出的 `.sha256` 比较；使用 GitHub CLI 上传 artifact 或创建 PR，不提交密钥和本地 preset。

- [ ] **Step 5: 记录验收结果**

在 PR 描述中列出实际执行的命令、快照名称、workflow run、artifact 名称和已知限制；不得声称未执行的检查通过。

## 验收清单

- [ ] 主智能体能同时派发多个 continuable child，并用 `list_agents` / `get_agent_status` 判断是否需要等待。
- [ ] 子智能体会在开始、阶段完成、阻塞和最终交付时通过 `report` 返回父级。
- [ ] `send_message`、`followup_task`、`steer_agent` 三种输入在 schema、日志和实际调度上语义不同。
- [ ] 父级可以执行 interrupt → steer，且 steering 在下一个安全 step 生效。
- [ ] `close_agent` 能幂等关闭目标子树并等待 dispose，不影响其他 child。
- [ ] 未授权 parent、ancestor、sibling、self、陈旧 Agent 和未知 id 的结果稳定且不产生副作用。
- [ ] SDK 和 Web 能显示实时报告、状态、最后活动和控制结果，刷新后状态不丢失。
- [ ] keyless snapshot、TypeScript SDK、Python SDK、桌面 portable 和移动端包均验证同一套事件语义。
