# Code-Pinned Multiagent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `code-pinned` 预设提供 Codex 式主从调度：可并行启动 continuable subagent，主控在关键路径被结果阻塞时通过 `wait_agent` 等待自己的 inbox 活动。

**Architecture:** 在 `@deepseek-ai/dsh-tool-subagent-control` 根插件中注册一个无 target 的 `wait_agent`，仅观察 `exec.agent.inbox` 和该 Agent 作用域的 `agent/inbox/inserted` 事件。工具不读取子智能体状态、不消费消息，也不声明静态工具超时；现有 agent loop 在下一 step 领取 inbox 消息。预设 persona 和 `multi-agent-delivery` Skill 负责调度纪律，真实组合快照固定模型可见行为。

**Tech Stack:** TypeScript ESM、Cordis、Vitest、DSH Agent Loop / inbox、Code Mode `run_code` SDK、ACP keyless snapshots、Markdown/i18n Agent Notes。

## Global Constraints

- 仅向 `tool-subagent-control` 根插件新增等待能力；不改变 `dsh-subagent` Service Definition、continuable 生命周期、`SessionEventMap` 或 `SESSION_FORMAT_VERSION`。
- `wait_agent` 不得声明 `ToolDefinition.timeoutMs`；`timeout_ms` 与 `exec.signal` 是唯一 deadline / 取消来源，正常超时返回工具结果而非 `TOOL_TIMEOUT`。
- 工具只能观察调用方 `exec.agent` 的 inbox；不接受 child id、target 或状态筛选，不调用 `ctx.subagents`、`list_agents`，不读取/复制/删除 inbox 消息。
- 按 `check → subscribe → re-check` 在没有 `await` 的同步区间内建立监听，保证既有消息和订阅附近插入的消息均不会丢失唤醒。
- `Wait completed.` 只表示下一 step 可领取消息，消息内容不会在当前模型 step 可见；persona 与 Skill 必须要求立即结束当前 step，禁止结果依赖调用和最终结论。
- 同一工具 registry scope 不得同时加载 normal control package 与 experimental Agent Team 的同名 `wait_agent`；重复 `ctx.tools.register()` 会确定性报错。
- 保持严格 TypeScript、ESM、函数插件具名导出、注册可 dispose、README 双语和 Agent Note 三联文件；生成的工具目录不手工修改。
- 预设文件位于用户 DSH home，不属于此 Git 仓库；在计划执行时单独修改 `C:\Users\liuxu001\.dsh\.agent-presets\code-pinned`，不把它加入仓库提交。
- 不提交现有未跟踪插件目录、`.npm_cache` 或 `src` 下生成的 `.js` / `.d.ts` / `.map` 文件。

---

## File Structure

| Path | Responsibility |
|---|---|
| `packages/subagent/tool-subagent-control/src/index.ts` | 注册 `wait_agent`，复用根插件既有的 `tools` / `subagents` 注入拓扑。 |
| `packages/subagent/tool-subagent-control/tests/tool-subagent-control.spec.ts` | 通过真实 Agent Loop / inbox 测试等待、超时、取消、隔离、清理和工具元数据。 |
| `packages/core/tools/tests/gen-tool-catalog.spec.ts` | 允许 catalog 同时收集 experimental 与 normal 两个 `wait_agent`，并锁定 normal 工具来源。 |
| `packages/subagent/tool-subagent-control/README.md` | 英文包契约、模型体验与同名工具限制。 |
| `packages/subagent/tool-subagent-control/README.zh.md` | README 的结构一致中文副本。 |
| `docs/subsystems/subagent.md` | 英文 subagent 子系统参考：父 inbox 等待的 Consumer 行为。 |
| `docs/subsystems/subagent.zh.md` | 子系统参考的结构一致中文副本。 |
| `.agents/notes/proposed/architecture/2026-08-31-inbox-based-subagent-waiting.{md,zh.md,i18n.yaml}` | 记录复用 inbox 而非 Agent Team/新队列的提议及验收边界。 |
| `docs/tool-catalog.md` / `docs/tool-catalog.zh.md` | 由目录生成器更新的工具 schema 投影；不手改。 |
| `C:\Users\liuxu001\.dsh\.agent-presets\code-pinned\agent.cordis.yml` | `code-pinned` 的稳定主从 persona。 |
| `C:\Users\liuxu001\.dsh\.agent-presets\code-pinned\skills\multi-agent-delivery\SKILL.md` | 工作包、证据和 wait-after-step 调度说明。 |
| `examples/acp-agent/tests/acp.snapshot.ts` | 注册 `code-mode-subagent-wait` ACP 场景。 |
| `examples/acp-agent/code-mode-subagent-wait.cordis.yml` | 真实 ACP composition 的 Code Mode overlay。 |
| `examples/acp-agent/code-mode-subagent-wait.cordis.snapshot.yml` | Keyless replay overlay，安装确定性 provider 与 parent/child 调度 fence。 |
| `examples/acp-agent/tests/fixtures/code-mode-subagent-wait-fence.ts` | 延迟 parent 收口，使 child report/settlement 与 `wait_agent` 的跨 step 顺序可复现。 |
| `examples/acp-agent/tests/snapshots/code-mode-subagent-wait/` | 输入脚本、root/child replay session、expected stdout、system prompt 和 tool schema 快照。 |

## Task 1: 实现并单测 `wait_agent`

**Files:**

- Modify: `packages/subagent/tool-subagent-control/src/index.ts`
- Modify: `packages/subagent/tool-subagent-control/tests/tool-subagent-control.spec.ts`

**Interfaces:**

- Consumes: `exec.agent`, `exec.signal`, `Agent.inbox.nextTurn`, `Agent.inbox.nextStep`，以及作用域事件 `'agent/inbox/inserted'`。
- Produces: 模型工具 `wait_agent({ timeout_ms?: number }): Promise<{ timedOut: boolean; message: 'Wait completed.' | 'Wait timed out.' }>`。
- Invariant: 消息由 agent loop 在下一 step 领取；工具仅报告可领取性。

- [ ] **Step 1: 先为 schema、已有消息与正常唤醒写失败测试**

在现有 `setupWith()` / `callTool()` 基座中增加如下断言：

```ts
it('registers wait_agent without a static timeout and with its optional timeout_ms parameter', async () => {
  const { ctx } = await setup([])
  const schema = ctx.tools.schemas().find(candidate => candidate.name === 'wait_agent')
  expect(schema).toBeDefined()
  expect((schema!.parameters as { properties?: Record<string, unknown> }).properties)
    .toEqual({ timeout_ms: expect.anything() })
  expect(ctx.tools.get('wait_agent')?.timeoutMs).toBeUndefined()
})

it('returns immediately for an inbox message still pending for a later step', async () => {
  const { ctx, parent } = await setup([])
  parent.followup(createUserMessage({ content: [{ type: 'text', text: 'already pending' }], source: { kind: 'plugin', plugin: 'test', form: 'notice' } }))
  const result = await callTool(ctx, 'wait_agent', {}, parent)
  expect(text(result)).toBe('Wait completed.')
  expect(parent.inbox.nextTurn).toHaveLength(1)
})
```

新增一项延迟调用：先取得 `const waiting = callTool(ctx, 'wait_agent', { timeout_ms: 1_000 }, parent)`，用 `vi.waitFor()` 证明尚未结算，再向 `parent.followup(...)` 插入消息；断言 `isError === false`、文本为 `Wait completed.`，且 inbox 仍保有相同消息。

- [ ] **Step 2: 运行定向测试，确认缺少工具导致失败**

Run: `pnpm exec vitest run packages/subagent/tool-subagent-control/tests/tool-subagent-control.spec.ts -t "wait_agent"`

Expected: FAIL，提示找不到 `wait_agent` schema 或 unknown tool。

- [ ] **Step 3: 在根插件写最小等待实现**

在 `apply(ctx)` 中，与 `send_message` 和 `interrupt_agent` 并列注册：

```ts
ctx.tools.register(defineTool({
  name: 'wait_agent',
  description: 'Wait until a new message is pending for your next step, or until timeout_ms expires. This does not read, return, or remove the message. When it returns Wait completed., end this step immediately: the message becomes visible in the next step.',
  parameters: {
    timeout_ms: {
      type: 'integer',
      required: false,
      minimum: 0,
      maximum: 3_600_000,
      description: 'Maximum milliseconds to wait. Defaults to 120000.',
    },
  },
  output: {
    schema: {
      type: 'object', additionalProperties: false,
      properties: {
        timedOut: { type: 'boolean', required: true },
        message: { type: 'string', required: true, enum: ['Wait completed.', 'Wait timed out.'] },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.message }],
  },
  async execute(args, exec) {
    const agent = exec.agent
    if (!agent) throw new Error('wait_agent requires a calling agent (exec.agent was undefined)')
    return waitForInbox(agent, args.timeout_ms ?? 120_000, exec.signal)
  },
}))
```

将竞态控制放入同文件私有 `waitForInbox()`：先以 `agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0` 检查，若为空，使用 `agent.ctx.on('agent/inbox/inserted', settleCompleted)` 注册 disposer，再同步复查 inbox。由一个 `settled` flag 和单一 `settle()` 负责 clearTimeout、移除 abort listener、调用 Cordis disposer，并解析或拒绝同一个 deferred promise。`exec.signal` 已中止时立即拒绝；否则添加一次性 abort listener。timer 到期解析 `{ timedOut: true, message: 'Wait timed out.' }`。不得给 `defineTool()` 传 `timeoutMs`。

- [ ] **Step 4: 写出竞态、边界和取消的失败测试**

补充测试并使用 fake timers（timer case）或受控 promise（事件 case）：

```ts
it('returns the normal timeout result instead of TOOL_TIMEOUT', async () => {
  vi.useFakeTimers()
  const { ctx, parent } = await setup([])
  const pending = callTool(ctx, 'wait_agent', { timeout_ms: 50 }, parent)
  await vi.advanceTimersByTimeAsync(50)
  expect(text(await pending)).toBe('Wait timed out.')
  vi.useRealTimers()
})

it('rejects on execution cancellation and removes its listener', async () => {
  const controller = new AbortController()
  const { ctx, parent } = await setup([])
  const pending = callTool(ctx, 'wait_agent', { timeout_ms: 1_000 }, parent, controller.signal)
  controller.abort()
  await expect(pending).resolves.toMatchObject({ isError: true })
  parent.followup(createTestMessage('after cancel'))
  // A later insertion cannot settle the cancelled call a second time.
})
```

还需覆盖：`timeout_ms` 默认值、`0`、上限 `3_600_000`、负数/超过上限/非整数的 schema 拒绝；其他 Agent 的 inbox 插入不唤醒；首检和订阅后复查间插入的消息仍唤醒；多个消息、超时和取消只得到一个结果；plugin fiber dispose 后 schema 消失且未留下 listener；缺少 calling agent 得到 errored tool result。使用 `try/finally` 复位 fake timers。

- [ ] **Step 5: 加入 timeout-policy 组合回归**

在同一测试文件或新建最小 composition test 中装载 `@deepseek-ai/dsh-tool-call-timeout-policy`，以小 `timeout_ms` 调用 `wait_agent`。断言工具结果为非 error 的 `Wait timed out.`，并明确断言注册定义没有静态 `timeoutMs`；此测试不得只 mock `defineTool`。

- [ ] **Step 6: 运行测试并检查覆盖路径**

Run: `pnpm exec vitest run packages/subagent/tool-subagent-control/tests/tool-subagent-control.spec.ts`

Expected: PASS，包含工具注册、同 Agent 唤醒、异 Agent 隔离、已 pending 消息、超时、取消、一次结算和 disposer 断言。

- [ ] **Step 7: 提交原语与单测**

```bash
git add packages/subagent/tool-subagent-control/src/index.ts packages/subagent/tool-subagent-control/tests/tool-subagent-control.spec.ts
git diff --cached --check
git commit -m "feat(subagent): add inbox wait control tool"
```

Expected: 一个只包含等待原语和定向测试的提交。若用户尚未授权提交，则保留 staged 之前的工作树改动并记录 `PASS_UNCOMMITTED`。

## Task 2: 更新 catalog 与公开文档

**Files:**

- Modify: `packages/core/tools/tests/gen-tool-catalog.spec.ts`
- Modify: `packages/subagent/tool-subagent-control/README.md`
- Modify: `packages/subagent/tool-subagent-control/README.zh.md`
- Modify: `docs/subsystems/subagent.md`
- Modify: `docs/subsystems/subagent.zh.md`
- Create: `.agents/notes/proposed/architecture/2026-08-31-inbox-based-subagent-waiting.md`
- Create: `.agents/notes/proposed/architecture/2026-08-31-inbox-based-subagent-waiting.zh.md`
- Create: `.agents/notes/proposed/architecture/2026-08-31-inbox-based-subagent-waiting.i18n.yaml`
- Generated: `docs/tool-catalog.md`, `docs/tool-catalog.zh.md`

**Interfaces:**

- Consumes: Task 1 的 `wait_agent` schema 和 source 路径。
- Produces: 生成目录中 normal/experimental 两个同名 schema，以及可部署限制的唯一文档来源。

- [ ] **Step 1: 写 catalog 断言并先验证失败**

在工具名精确数组里新增第二个 `'wait_agent'`，并把 source 映射改为：

```ts
expect(control?.sources).toEqual({
  interrupt_agent: 'packages/subagent/tool-subagent-control/src/index.ts',
  list_agents: 'packages/subagent/tool-subagent-control/src/list-agents.ts',
  send_message: 'packages/subagent/tool-subagent-control/src/index.ts',
  wait_agent: 'packages/subagent/tool-subagent-control/src/index.ts',
})
```

Run: `pnpm exec vitest run packages/core/tools/tests/gen-tool-catalog.spec.ts`

Expected: 在 Task 1 完成、断言尚未更新时 FAIL，报告 names/source 不匹配；更新后 PASS。

- [ ] **Step 2: 写包 README 的模型可见语义和限制**

在英中文 README 同步新增 `wait_agent`：它等待调用 Agent 的下一 step inbox 活动、输出固定 `Wait completed.` / `Wait timed out.`、不返回内容且不消费消息；说明 completed 后必须结束当前 step；声明 `timeout_ms` 拥有参数化等待 deadline 且没有静态 `timeoutMs`。在 `## Known Limitations and Deferred Work` 写明：normal 与 `@deepseek-ai/dsh-experimental-tool-agent-team` 都注册全局 `wait_agent`，同一 registry scope 只能选择其一，catalog 可以收集两份 schema；`wait_agent` 不是 child 状态查询，且没有运行 child/预期报告时不应调用。

- [ ] **Step 3: 更新子系统参考与 Agent Note**

在 `docs/subsystems/subagent.{md,zh.md}` 的 control Consumer 说明中链接包 README，并明确父 Agent inbox 是报告/结算通知的单一队列，`wait_agent` 不额外持久化消息、结果或状态。

按 Agent Note 格式写 `proposed/architecture` 三联文件。英文和中文都使用：`## Problem`、`## Proposal`、`## Alternatives considered`、`## Acceptance criteria`、`## Risks`。至少记录：为什么不用 experimental `TeamActivity`；为什么不创建第二个 wait 队列；为什么保留 root plugin 的 `subagents` 注入以换取 `code-pinned` 零配置；静态 timeout 与 guard 的冲突；同名工具 scope 限制；模型在 completed 后跨 step 才能读取消息。

- [ ] **Step 4: 重生成目录并跑最小文档检查**

先确认生成命令：`pnpm run doc-sync -- --help` 或在 `package.json` / `scripts/run-gates.ts` 定位 `gen-tool-catalog` 的单独入口。执行生成器，不手工编辑 `docs/tool-catalog.md`；按 i18n pairing workflow 生成或更新中文副本和 sidecar。

Run: `pnpm exec vitest run packages/core/tools/tests/gen-tool-catalog.spec.ts`

Expected: PASS，catalog 仍包含 experimental 和 normal 两条同名 `wait_agent`，且 normal 条目来自 control package。

Run: `pnpm run doc-sync`

Expected: PASS；若仅需定位失败，先运行报告的最窄 generator/validator，再修复对应来源，不修改生成区域。

- [ ] **Step 5: 提交 catalog 与文档**

```bash
git add packages/core/tools/tests/gen-tool-catalog.spec.ts packages/subagent/tool-subagent-control/README.md packages/subagent/tool-subagent-control/README.zh.md docs/subsystems/subagent.md docs/subsystems/subagent.zh.md .agents/notes/proposed/architecture/2026-08-31-inbox-based-subagent-waiting.md .agents/notes/proposed/architecture/2026-08-31-inbox-based-subagent-waiting.zh.md .agents/notes/proposed/architecture/2026-08-31-inbox-based-subagent-waiting.i18n.yaml docs/tool-catalog.md docs/tool-catalog.zh.md
git diff --cached --check
git commit -m "docs(subagent): document inbox waiting"
```

Expected: 一个不混入预设、生成物或未跟踪目录的文档/目录提交。未获提交授权则标记 `PASS_UNCOMMITTED`。

## Task 3: 更新 code-pinned persona 与 Skill

**Files:**

- Modify: `C:\Users\liuxu001\.dsh\.agent-presets\code-pinned\agent.cordis.yml`
- Modify: `C:\Users\liuxu001\.dsh\.agent-presets\code-pinned\skills\multi-agent-delivery\SKILL.md`

**Interfaces:**

- Consumes: Task 1 的 SDK-visible `wait_agent`，以及 continuable `subagent`、`send_message`、`interrupt_agent`、`list_agents`。
- Produces: 预设层的 Codex 式关键路径调度和五阶段交付约束。

- [ ] **Step 1: 在 persona 写稳定调度约束**

替换当前 persona 中“主控亲自运行最多两条门禁命令”等绝对分工语言为设计文档第 8 节的内容。必须逐字保留这条模型关键指令：

```text
wait_agent 返回 Wait completed. 时，当前 step 还看不到唤醒消息内容。立即结束当前 step：不要继续调用依赖该结果的工具，也不要输出最终结论；下一 step 会把消息作为输入送达。
```

还要包含：主控继续未委派且不重叠的关键路径；不得重做已委派工作；先并行启动当前所有独立 child，之后才等待；无运行 child/预期报告/用户等待理由时不得空等；Reviewer 使用全新 `subagent`，不使用继承上下文的 `subagent_fork`。

- [ ] **Step 2: 将 Skill 重构为六个职责段落**

将 Skill 收敛为：适用范围；关键路径/旁路与任务卡；Codex 调度循环；五阶段和证据来源；失败/降级/提交授权；最终交付。保留如下可执行 Code Mode 示例：

```ts
await Promise.all([
  tools.subagent({ description: 'WP-A', prompt: taskA }),
  tools.subagent({ description: 'WP-B', prompt: taskB }),
])
// 仅在没有不重叠关键路径工作且下一步依赖结果时：
return await tools.wait_agent({ timeout_ms: 60_000 })
```

明确禁止：`spawn A → wait → spawn B`；在 `Promise.all` 中把尚未启动的委派与 `wait_agent` 混在一起；主控批量读文档/搜索结果来重做 Explorer；子智能体写入期间提交；completed 后在同一 step 继续结果依赖调用或输出终结结论。将 Reviewer 改为全新 `subagent`，而不是 `subagent_fork`。

- [ ] **Step 3: 校验预设 YAML 和 Skill 文字**

Run: 使用仓库现有 Cordis 配置验证脚本检查 `agent.cordis.yml`；若该脚本只接受仓库内文件，复制到临时目录并以相同 resolver 执行，不能修改真实用户配置来规避验证。

Run: `rg -n "wait_agent 返回 Wait completed|subagent_fork|最多运行 2 条命令|spawn A" C:\Users\liuxu001\.dsh\.agent-presets\code-pinned\agent.cordis.yml C:\Users\liuxu001\.dsh\.agent-presets\code-pinned\skills\multi-agent-delivery\SKILL.md`

Expected: 必有结束当前 step 指令；不再将 Reviewer 指向 `subagent_fork`，不再保留“最多两条命令”的已删除限制；保留反例说明。

- [ ] **Step 4: 记录预设外部变更，不加入仓库提交**

Run: `git status --short --branch`

Expected: 仓库 staged set 不包含 `C:\Users\liuxu001\.dsh`；最终交付列出外部预设路径、备份/回退方式和生效所需的新会话。

## Task 4: 添加真实组合 keyless snapshot

**Files:**

- Modify: `examples/acp-agent/tests/acp.snapshot.ts`
- Create: `examples/acp-agent/code-mode-subagent-wait.cordis.yml`
- Create: `examples/acp-agent/code-mode-subagent-wait.cordis.snapshot.yml`
- Create: `examples/acp-agent/tests/fixtures/code-mode-subagent-wait-fence.ts`
- Create: `examples/acp-agent/tests/snapshots/code-mode-subagent-wait/input.json`
- Create: `examples/acp-agent/tests/snapshots/code-mode-subagent-wait/session.jsonl`
- Create: `examples/acp-agent/tests/snapshots/code-mode-subagent-wait/session.1.jsonl`
- Create: `examples/acp-agent/tests/snapshots/code-mode-subagent-wait/session.2.jsonl`
- Create: `examples/acp-agent/tests/snapshots/code-mode-subagent-wait/stdout.expected.jsonl`
- Create: `examples/acp-agent/tests/snapshots/code-mode-subagent-wait/system-prompt.expected.md`
- Create: `examples/acp-agent/tests/snapshots/code-mode-subagent-wait/tool-schemas.expected.json`
- Create: `examples/acp-agent/tests/snapshots/code-mode-subagent-wait/system-prompt.1.expected.md`
- Create: `examples/acp-agent/tests/snapshots/code-mode-subagent-wait/tool-schemas.1.expected.json`
- Create: `examples/acp-agent/tests/snapshots/code-mode-subagent-wait/system-prompt.2.expected.md`
- Create: `examples/acp-agent/tests/snapshots/code-mode-subagent-wait/tool-schemas.2.expected.json`

**Interfaces:**

- Consumes: Task 1 的工具 schema，ACP Code Mode composition、`dsh-acp-snapshot` 与 `dsh-llm-replay`。用户目录的 `code-pinned` persona/Skill 不进入仓库测试装配，因此由 Task 3 手动验收。
- Produces: 无密钥可重放 transcript，证明 Code Mode SDK 实际并行委派并跨 step 等待，而不只是 schema 存在。

- [ ] **Step 1: 先创建期望行为的失败场景**

在 `examples/acp-agent/tests/acp.snapshot.ts` 声明 `CODE_MODE_SUBAGENT_WAIT_CONFIG`，并在 `SCENARIOS` 添加 `{ name: 'code-mode-subagent-wait', hasModelTurn: true, recorded: false, pinsHeader: true, headerClass: 'code-subagent-wait', configPath: CODE_MODE_SUBAGENT_WAIT_CONFIG, pinsChildToolSchemas: [1, 2], pinsChildSystemPrompts: [1, 2] }`。

创建 Code Mode include overlay：以 `code-mode.cordis.yml` 为模板保留 `tools.mode: code` 和 `code-runtime`，在 replay twin 中禁用 `llm-deepseek` 并安装 `dsh-llm-replay`，最后加载 `./tests/fixtures/code-mode-subagent-wait-fence.ts`。`input.json` 的唯一 prompt 要求模型在**一个** `run_code` 程序中以 `Promise.all` 启动两个 `tools.subagent(...)`，完成独立协调后调用 `tools.wait_agent({ timeout_ms: 1_000 })`，随后只在下一 step 处理第一份报告。两个 child 的 replay session 分别回传 `report` 与 settlement；fence 保证 parent 的 wait 已注册后才释放第一 child，并让第二 child 在 parent 被第一份消息唤醒时仍未结束。

场景断言从持久 `session.jsonl` / rendered transcript 读取：两个 subagent tool calls 同 step、一个 `wait_agent` 调用、wait result 文本、紧随其后的 inbox message 和后续 step，以及最终回答顺序。不要通过 mock 直接断言 prompt 字符串代替 assembled transcript。

- [ ] **Step 2: 录制或手工构造最小合法 replay fixture**

按本仓库 snapshot policy 使用允许的流程：有模型密钥时 `pnpm run test:snapshot:record -- -t "code-mode-subagent-wait"` 录制；无密钥时基于真实 ACP event 格式的确定性 `dsh-llm-replay` session fixture 驱动，不伪造运行后的 expected log。随后执行 `pnpm run test:snapshot:refresh -- -t "code-mode-subagent-wait"` 生成 `stdout.expected.jsonl`、system prompt 和 tool schema 伴随文件。

- [ ] **Step 3: 运行目标 snapshot 并修正实际装配问题**

Run: `pnpm run test:snapshot -- -t "code-mode-subagent-wait"`

Expected: PASS，且输出证明第一 child 完成只唤醒主控、并未终止其他 child；主控在 completed 所在 step 没有发布最终结论。

- [ ] **Step 4: 进行预设手动验收**

新建一个 `code-pinned` 会话，要求其处理“两项不相交改动 + 一项整体检查”。观察工具调用：先并行派发，再推进不重叠关键路径，确实阻塞后调用 `wait_agent`；Worker/Verifier/Reviewer 仍是独立上下文；未授权提交时结论为 `PASS_UNCOMMITTED`。记录 session id 和可重复命令，但不在代码中硬编码本机模型凭据。

- [ ] **Step 5: 提交 snapshot**

```bash
git add examples/acp-agent/tests/acp.snapshot.ts examples/acp-agent/code-mode-subagent-wait.cordis.yml examples/acp-agent/code-mode-subagent-wait.cordis.snapshot.yml examples/acp-agent/tests/fixtures/code-mode-subagent-wait-fence.ts examples/acp-agent/tests/snapshots/code-mode-subagent-wait
git diff --cached --check
git commit -m "test(subagent): cover code-pinned wait coordination"
```

Expected: 一个仅包含组合测试配置和 replay 产物的提交；无提交授权时保留 `PASS_UNCOMMITTED`。

## Task 5: 端到端复验与交付

**Files:**

- Verify: Tasks 1–4 的文件；不新增产品文件。

**Interfaces:**

- Consumes: 单测、catalog、文档、snapshot 与预设人工验收。
- Produces: 可合并的证据包，或明确的 `BLOCKED` / `PASS_UNCOMMITTED` 状态。

- [ ] **Step 1: 运行最小充分检查**

```bash
pnpm exec vitest run packages/subagent/tool-subagent-control/tests/tool-subagent-control.spec.ts
pnpm exec vitest run packages/core/tools/tests/gen-tool-catalog.spec.ts
pnpm run typecheck
pnpm run doc-sync
pnpm run test:snapshot -- -t "code-pinned multiagent"
git diff --check
```

Expected: 每条命令退出码为 0。若任何命令失败，先按最窄失败面诊断；不修复无关失败，并在交付中列出其命令与原始失败摘要。

- [ ] **Step 2: 独立复审变更边界**

检查 `git diff --name-only origin/master...HEAD`：仅允许 Task 1–4 的源码、测试、文档、Agent Note、catalog 和 snapshot 文件。特别确认不存在 `vendor/` 修改、Session 格式改动、静态 `timeoutMs`、`ctx.subagents` 在 `wait_agent` 中的调用、预设目录被 staged、或生成 `.js/.d.ts/.map` 产物。

- [ ] **Step 3: 准备交付或提交授权后的串行提交**

若用户授权提交，按 Task 1、2、4 的顺序逐个检查 staged diff、执行 `git diff --cached --check` 和各自最小测试后提交。否则汇报 `PASS_UNCOMMITTED`，列出所有修改文件、已运行命令、外部预设改动和建议的三条提交信息；不得推送、开 PR 或合并。

## Spec Coverage Review

- `wait_agent` 接口、无 target、同 Agent inbox、消息不消费、同步双检、timeout/cancel、无静态 timeout：Task 1。
- timeout guard 直通与 catalog 的两个同名 schema：Task 1 和 Task 2。
- README Known Limitations、subsystem docs、Agent Note、生成目录：Task 2。
- Codex 混合调度、completed 后立即结束 step、Verifier/Reviewer 分工、五阶段和 `PASS_UNCOMMITTED`：Task 3。
- keyless 模型可见 transcript 与手动 `code-pinned` 验收：Task 4。
- 类型、文档、snapshot、变更范围与未跟踪文件保护：Task 5。

## Plan Self-Review

- 已逐项覆盖设计文档第 5、8、9、11、12、13 节与 review 中的 P1/P2/P3 结论。
- 接口名在全部任务中一致：`wait_agent`、`timeout_ms`、`timedOut`、`Wait completed.`、`Wait timed out.`。
- 计划不依赖 `subagent_fork`、不创建 Session 事件、不手改生成目录，也未把共享工作区的提交并发化。
- Task 4 的精确 snapshot 路径需以执行时仓库实际的 code-pinned 装配入口为准；这是现有用户目录预设缺少仓库测试挂载点导致的发现步骤，不得凭空创建不被 snapshot runner 加载的文件。
