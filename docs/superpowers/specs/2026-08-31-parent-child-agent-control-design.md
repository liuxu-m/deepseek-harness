# 父子智能体控制与进度协作设计

## 目标

为 Harness 提供完整的 Codex 风格父子智能体体验：主智能体可以并行派发任务、等待结果、查看子智能体进度、向正在运行的子智能体插话、暂停或关闭子智能体，并通过客户端事件看到同一棵智能体树的状态变化。

## 背景与现状

`dsh-subagent` 已经提供可继续子智能体、持久化会话、父级谱系和冷恢复。`dsh-tool-subagent-control` 已经提供 `send_message`、`interrupt_agent`、`list_agents` 和 `wait_agent`；`dsh-tool-subagent-report` 已经提供子级向直接父级发送报告的通道。当前缺少的是把这些能力组合成完整的控制协议：`send_message` 同时承担排队和唤醒语义，父级没有 `steer` 工具，缺少模型可调用的关闭和详细状态查询，`report` 也没有进入当前 `code-pinned` 预设。

Codex CLI 的多智能体实现将排队消息、触发下一轮、打断、等待和关闭分成独立操作；其客户端还通过 turn 控制和活动事件呈现运行状态。本设计借鉴这些可验证的交互语义，不复制 Codex 的传输实现。

## 设计范围

本设计包含五个层次：

1. 子智能体服务：消息路由、steering、关闭、状态快照和权限。
2. 模型工具：父到子控制、子到父报告、状态查询和等待提示词。
3. 会话事件：让模型可见状态、报告和控制结果可重放。
4. SDK 与 Web 客户端：订阅智能体树、显示进度、选择排队或插话。
5. 预设和发布：更新 persona、Skill、工具目录、快照和桌面打包流程。

一次性远程 provider 只获得其声明支持的能力；父子实时控制首先针对具有在线 `Agent` 的可继续子智能体实现。远程或一次性子智能体仍通过 provider 自己的结果、取消和通知协议工作。

## 核心决策

### 1. 分离四种父到子操作

| 操作 | 作用 | 是否唤醒 | 是否改变当前轮次 |
|---|---|---:|---:|
| `send_message` | 将普通消息放入子级 FIFO | 否 | 否 |
| `followup_task` | 放入 FIFO 并启动或恢复下一轮 | 是 | 否 |
| `steer_agent` | 将 steering 放入子级 next-step 队列 | 已物化且空闲时是 | 在下一个安全 step 生效 |
| `interrupt_agent` | 取消当前轮次并保留未领取 inbox | 否 | 立即请求停止，实际停稳异步完成 |

`steer_agent` 不伪装成 token 级中断。子智能体正在执行当前工具或模型请求时，消息在下一个 `pre-step` 边界进入上下文；需要强制改道时，父级先 `interrupt_agent`，再 `steer_agent`。已有持久 Activation 但处于 `idle` 的子级可以被 steering 唤醒；尚未物化 Activation 的 cold child 不由 steering 隐式启动，必须先 `followup_task`。

### 2. 增加显式关闭

`close_agent` 是与 `interrupt_agent` 不同的生命周期操作。它先设置关闭 sentinel，再以 child-first 顺序关闭目标拥有的可继续后代，取消尚未领取的目标 inbox，等待所有在线 handle 完成 dispose，最后保留持久化会话作为历史记录。重复关闭、已完成目标和未知目标统一返回 `accepted: true, noOp: true`；同级、self、非 ancestor 和陈旧权限均拒绝。

关闭不删除会话日志，不删除目录投影，不影响父级其他子智能体。服务拥有唯一的关闭事务，所有并发关闭请求共享同一完成点。

### 3. 报告与状态各司其职

`report` 只承载子智能体主动选择的阶段性摘要；它不结束轮次，也不替代最终结算通知。`code-pinned` 默认安装 `report`，并在子级 persona 中要求：开始、阶段完成、阻塞和最终交付至少各报告一次。

新增 `get_agent_status` 只返回服务生成的状态快照，不读取任意子级原始 transcript。快照字段固定为：

```ts ignore-check
type SubagentTurnId = Branded<'SubagentTurnId'>

interface SubagentStatusSnapshot {
  readonly agentId: SessionId
  readonly parentSessionId: SessionId
  readonly state: 'running' | 'idle' | 'ready' | 'completed' | 'failed' | 'interrupted' | 'closed'
  readonly currentTurnId?: SubagentTurnId
  readonly phase?: string
  readonly lastActivityAt?: number
  readonly lastReport?: string
  readonly pendingMessageCount: number
  readonly stopReason?: string
}
```

`SessionId`、`MessageId`、`SubagentTurnId` 和 `SubagentControlRequestId` 都是 branded opaque id。`phase`、`lastReport` 和 `stopReason` 的最大 UTF-8 字节数由 profile 配置并在解析阶段校验；超限值不进入日志或模型上下文。`list_agents` 继续提供树快照；`get_agent_status` 用于单个目标的详细查询；报告和状态事件用于客户端实时更新。状态字段不把“有结果可领取”与 `idle` 混为一谈，`ready` 只表示可恢复；状态查询本身不生成 `requestId`。

### 4. 所有模型可见信息必须可重放

新增控制结果、报告、阶段、状态和关闭原因都先写入声明过的 session event，再由工具输出、父级 inbox、SDK 通知和 Web 状态投影消费。不得从在线 Agent 的易失字段直接拼接模型输入。

事件至少包括：

- `subagent/message-accepted`
- `subagent/steer-accepted`
- `subagent/interrupt-requested`
- `subagent/closed`
- `subagent/progress`

事件由 `dsh-subagent` owning package 在 `descriptor.ts` 中声明并通过 `SessionEventMap` 合并；事件字段固定为 `eventSeq`、`occurredAt`、`agentId`、`parentSessionId`、`requestId` 或 `messageId`、`state` 及必要的来源信息。`subagent/message-accepted` 和 `subagent/steer-accepted` 在消息持久化成功后发布，`subagent/interrupt-requested` 在停止请求登记后发布，`subagent/closed` 只在关闭事务完成后发布，`subagent/progress` 在阶段或报告投影改变后发布。新增事件使用可忽略 envelope；若改变既有事件结构，再单独评估 `SESSION_FORMAT_VERSION`。`report` 不新增第二份父级 transcript：子级的 `tool/call`、`tool/result` 记录工具调用，父级的 `user/message` 记录报告正文；`subagent/progress` 只记录状态快照所需的阶段、活动时间和计数，属于 log-only 事件。生成器必须同步 `known-event-types.ts`、双语 persistence catalog 及 freshness tests。

`phase`、`lastReport`、`stopReason` 的 profile 配置字段分别为 `maxPhaseBytes`、`maxReportBytes`、`maxStopReasonBytes`，均为启动时校验的正整数；缺省值由部署 profile 明确提供，运行时不得写死第二套默认值。所有事件和控制结果中的 ID 都使用对应 branded 类型，跨进程协议只在解析后转换为品牌值。

### 5. 权限沿用确切在线谱系

父到子工具将调用方 `exec.agent` 传入服务，由服务依据持久化 `parentSession` 和当前 Activation lineage 做最终鉴权。`list_agents` 的结果只是快照，不能作为后续操作的授权凭据。直接父级可以发送和 steering；祖先可以中断或关闭后代；self、sibling、root 伪装、陈旧 Agent 和未知目标都返回明确错误。

关闭使用独立的 `SubagentCloseAuthority`，避免把级联关闭权限与普通中断权限混用：

```ts ignore-check
type SubagentCloseAuthority =
  | { readonly kind: 'direct-parent'; readonly agent: Agent }
  | { readonly kind: 'ancestor'; readonly agent: Agent; readonly cascade: true }
```

## 模型工具契约

### `send_message`

参数为 `subagent_id`、`message`。消息只入队，不改变当前轮次；返回被接受的 `messageId`。在线 child 直接把消息追加到 Agent inbox，不调用 `followup()`；冷 child 在 continuation manager 的 child lock 内物化 Activation、将消息追加到持久 inbox 后立即进入 `waiting`，不启动 driver。后续 `followup_task` 或 `steer_agent` 复用该 Activation 并唤醒它。物化与关闭并发时由 disposal sentinel 决定先后，重启后 queue 消息从持久 inbox 恢复且不会被 watcher 当作 settled child 释放。调用方需要使用 `followup_task` 才能触发下一轮。

### `followup_task`

参数与 `send_message` 相同。消息入队后启动或恢复子级；返回 `messageId` 和 `accepted: true`。目标必须是可继续子级，root 不可作为目标。

### `steer_agent`

参数为 `agent_id`、`message`。服务调用目标 `Agent.steer()`，消息来源标记为 `coordinator`，返回 `messageId`、`accepted` 和 `effectiveStep: 'next-step'`。steering 只允许在线或由显式 `followup_task` 唤醒后的 Activation；对冷 child 不隐式启动 driver，父级必须先 `followup_task`。若目标已关闭或不存在，返回幂等 no-op，不创建隐式新子级。

### `interrupt_agent`

保留现有参数和 `keepInbox` 语义，补充 `previousState`、`requestId` 和可观察的 `interrupt-requested` 事件。工具返回表示“停止请求已接受”，不声称目标已经停稳。

### `close_agent`

参数为 `agent_id`、可选 `cascade`，其中 `cascade` 默认 `true`。关闭权限使用独立的 `SubagentCloseAuthority`，允许确切的在线直接父级或祖先；祖先关闭后代时必须明确接受级联影响。返回 `previousState`、`closedAgentIds`、`requestId`、`accepted` 和 `noOp`。未知、已完成或重复目标返回幂等 no-op；关闭会清除普通 queue 和 steering，但保留已写入日志的报告，且结果只在关闭事务完成后发布。

### `get_agent_status`

参数为 `agent_id`。只允许父级或祖先查询自己的子树，返回 `SubagentStatusSnapshot`。不存在目标返回诊断，不读取其他会话的内容。`currentTurnId` 使用 branded `SubagentTurnId`，`requestId` 使用 branded `SubagentControlRequestId`；`phase`、`lastReport` 和 `stopReason` 受配置的 UTF-8 字节上限约束，超限输入在工具执行前拒绝。

### `report`

保留现有 `output` 字符串参数和 `next-step` / `quiet` 部署策略；默认 `next-step`。扩展提示词要求报告内容自足、短小、说明阶段和下一步，不放入大段 transcript。

## 运行时流程

```text
父级 spawn continuable child
        |
        +--> child report(progress) --> parent inbox --> wait_agent --> next step
        |
        +--> parent get_agent_status/list_agents
        |
        +--> parent send_message (queue only)
        +--> parent followup_task (queue + wake)
        +--> parent interrupt_agent
        +--> parent steer_agent (next safe step)
        +--> parent close_agent (child-first dispose)
```

`wait_agent` 仍然只等待调用方 inbox 的 pending 边沿，不查询 child 状态。主控应先用 `get_agent_status` 或 `list_agents` 选择目标，再决定等待、发送、steering 或关闭；`wait_agent` 返回 `Wait completed.` 后必须结束当前 step，下一 step 才能领取报告或结算消息。

## 客户端请求与通知

SDK 服务端复用已有 `subagent.started`、`subagent.finished`、`session.status` 通知，新增 `subagent.progress`、`subagent.control` 和 `subagent.report` 通知，并增加带已打开 parent session 权限上下文的 `subagent/control` 与 `subagent/status` JSON-RPC requests：

```ts ignore-check
interface SubagentControlParams {
  readonly parentSessionId: SessionId
  readonly agentId: SessionId
  readonly action: 'queue' | 'followup' | 'steer' | 'interrupt' | 'close'
  readonly message?: string
  readonly cascade?: boolean
}
```

服务端在 `HarnessSdkRequestMap` 和 JSON-RPC dispatcher 中实现这两个请求：从已打开的 parent session 恢复确切 Agent，不接受客户端伪造 ancestor；响应统一为 `SubagentControlResult` 或结构化拒绝。`subagent/status` 返回同一份 `SubagentStatusSnapshot`，用于 UI 刷新时恢复状态。SDK 客户端提供按根会话过滤的树订阅和按 agent id 的状态缓存，通知乱序时以事件序号和时间戳丢弃旧快照；缓存丢失时必须通过 `subagent/status` 重建，而不是从 UI 本地猜测。

Web 客户端在 `ui-subagent` 的现有子智能体树中增加状态面板：每个节点显示状态、阶段、最近报告、最后活动时间和待处理消息数；操作菜单通过 `subagent/control` request 提供“排队发送”“下一轮发送”“插话”“打断”“关闭”。发送和 steering 的确认显示 request id，关闭显示级联影响。UI 只显示服务确认过的状态，不把乐观更新当作完成。

桌面客户端沿用 Web/SDK 协议，不新增独立本地状态机。启用新工具或更新预设必须重启 Session；源代码能力变更完成后再运行现有桌面 workflow 打包。

## 测试与验收

### 单元与组合测试

- `send_message` 不唤醒 idle child；`followup_task` 唤醒并触发下一轮。
- `steer_agent` 在 running child 的下一个 step 可见，在已有 Activation 的 idle child 上启动新轮次；cold child 必须先 `followup_task`。
- `interrupt_agent` 保留未领取 inbox；`steer_agent` 可在打断后接管方向。
- `close_agent` 级联关闭后代、幂等处理重复请求并等待 dispose。
- 直接父级、祖先、self、sibling、陈旧 Agent 和未知 id 的权限矩阵。
- `get_agent_status` 不泄露非子树会话，状态字段与事件顺序一致。
- `report`、结算通知和 steering 同步到 parent inbox 时保持 FIFO；`wait_agent` 只产生一次唤醒。
- timeout guard 不截断 `wait_agent` 的参数化 deadline。

### Keyless snapshot

新增真实 Loader/ACP composition，覆盖：并行启动两个 child、一个阶段性 report、父级查询状态、父级 steering、打断后改道、关闭另一个 child、最终结算。快照锁定工具 schema、system prompt、父级可见消息、状态通知和 session event 顺序。

### 发布验收

通过 `pnpm run test`、`pnpm run typecheck`、`pnpm run lint`、`pnpm run doc-sync`、`pnpm run build`、定向 Web e2e、keyless snapshot 和桌面 workflow。重新生成工具目录，不手改生成文件；更新 TypeScript 与 Python SDK 期望输出。

## 分阶段交付

1. **P0 控制闭环**：启用 `report`，拆分 `send_message` / `followup_task`，增加 `steer_agent` 和模型提示词。
2. **P1 生命周期与查询**：增加 `close_agent`、`get_agent_status`、状态事件和权限矩阵。
3. **P1 客户端可视化**：SDK 通知、树订阅、Web 控制面板和 UI e2e。
4. **P2 可靠性**：投递回执、幂等键、速率限制、跨进程租约和失败重试协议。

P0 完成后主智能体已经可以汇报、查询、打断和重新指定方向；P1 完成后才具备完整的生命周期和可视化控制；P2 不阻塞单机 code-pinned 预设发布。

## 非目标

- 不把 `steer_agent` 做成 token 级抢占，不修改模型供应商的生成协议。
- 不让父级直接读取子级全部 transcript；详细历史仍属于子级会话，按授权通过专用查询或客户端打开。
- 不把一次性远程 provider 强行伪装成可继续 Agent。
- 不在 `agent-loop` 中加入子智能体专用分支；控制行为通过 Agent inbox、subagent service 和插件扩展点实现。
