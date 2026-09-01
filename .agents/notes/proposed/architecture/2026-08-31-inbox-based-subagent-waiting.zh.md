# Agent Note: 基于 inbox 的子智能体等待

Status: proposed

English | [中文](2026-08-31-inbox-based-subagent-waiting.md)

## Problem

可继续子智能体通过直属父 Agent 的 inbox 报告和结算，但主控在等待这些信息时没有面向模型的阻塞操作。轮询 `list_agents` 不能确定完成；没有等待工具而直接结束 turn，只能依赖提示词调度。

## Proposal

`@deepseek-ai/dsh-tool-subagent-control` 注册全局 `wait_agent`。工具只观察 `exec.agent.inbox` 和调用 Agent 作用域内的 `agent/inbox/inserted` 事件。它先检查 pending 输入、订阅、再同步复查，因此订阅附近的消息不会丢失。它不复制也不移除消息；agent-loop 在下一 step 边界领取消息。

可选 `timeout_ms` 是 0 到 3600000 的安全整数。工具拥有该 deadline 和 `exec.signal`，因此不声明静态 `ToolDefinition.timeoutMs`；正常到期返回 `Wait timed out.`，不会变成 guard 所有的 `TOOL_TIMEOUT`。`Wait completed.` 要求模型结束当前 step，因为消息内容到下一 step 才可见。

工具保留在 root control plugin 中，使现有 code-pinned composition 不增加 Cordis 行即可公开它；等待本身不检查该服务，但接受该包既有的 `subagents` 注入。

## Alternatives considered

**复用实验 Agent Team 等待。** Team activity 依赖另一套 roster、mailbox 和 task-board 模型；它会向 continuable-subagent 部署加入持久 team state，并与全局工具名冲突。

**从等待调用返回 child 输出。** 这会复制父 inbox 已拥有的消息，破坏 agent-loop 使用的单一顺序真源。

**新增独立等待队列。** 第二个队列需要 durability、顺序、取消和 projection 规则，而现有 inbox 已提供这些能力。

## Acceptance criteria

- 单元测试覆盖已有和新插入 inbox 消息、超时、取消、跨 Agent 隔离、订阅竞态、dispose 和 timeout-policy 组合。
- 生成目录记录 normal 与 experimental 的 `wait_agent` schema，并将 normal 项归属 control package。
- 包文档说明下一 step 可见性和单一 scope 的重名限制。
- Code Mode replay 展示并行委派、inbox 等待和主控在下一 step 消费第一份 child report。

## Risks

没有有用消息会到来时，`wait_agent` 会等到请求 deadline。persona 和 Skill 必须禁止空等，且禁止在 completed 所在工具 step 调用依赖结果的工具。部署不得在同一 registry scope 同时挂载本包与实验 Agent Team。
