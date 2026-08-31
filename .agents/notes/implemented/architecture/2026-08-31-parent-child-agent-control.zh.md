# Agent Note: Parent-child agent control workflow

Status: implemented

[English](2026-08-31-parent-child-agent-control.md) | 中文

## Problem

可继续的 child agent 可能在启动它的 parent step 结束后继续存在。没有统一的协调流程时，parent 无法区分排队工作与唤醒的后续轮次，无法安全纠正正在运行的 child，也无法关闭被放弃的后代并保留供 SDK 与 UI 使用的持久化证据。

## Decision

随附的 `code` preset 安装 parent 控制工具和内置 `multi-agent-delivery` skill；其宿主 composition 只加载一次 child 作用域的 `report` 通道。Persona 与 skill 要求 parent 并行派发独立工作、请求里程碑报告、使用状态快照而不是忙轮询、只在预期 inbox 消息时等待，并在 `Wait completed.` 之后立即结束当前 step。

Parent 控制具有不同的调度语义：`send_message` 只排队不唤醒，`followup_task` 排队并唤醒，`steer_agent` 在下一安全 step 投递纠偏上下文。`interrupt_agent` 只停止当前轮次并保留排队工作与后代。`close_agent` 在直接父级或祖先权限下关闭 child 子树。持久化控制、进度、报告和结算观测仍可投影给 SDK 与 UI，但不暴露 child 私有提示词或完整 transcript。

内置 skill 根目录由 preset 的 `baseUrl` 解析，因此随附安装和复制的本地 preset 使用相同 composition。本机 `code-pinned` 覆盖只用于验证，不属于仓库或发布产物。

## Alternatives considered

**只依赖工具描述。** 否决，因为 `wait_agent` 后的 step 边界规则以及先中断再 steering 的顺序属于必须同时出现在 persona 与可复用 skill 中的行为约束。

**公开一个通用 child 消息操作。** 否决，因为排队、唤醒、steering、中断和关闭具有不同的生命周期影响与权限检查；合并会鼓励意外唤醒或错误地假定工作已完成。

**向 parent 流式传输完整 child transcript。** 否决，因为报告与生命周期通知提供有界且经选择的证据，持久化 child 会话仍是恢复记录。

## Consequences

随附 code preset 为模型提供明确的 parent-child 协调指引和六项控制操作；其宿主 composition 只加载一次 report。英文及中文 package/subsystem 参考、生成目录与来源断言描述相同的控制和通知限制。由于实验性的 Agent Teams 包定义了重叠的全局工具名，每个 registry scope 仍必须选择一个控制包。过期的本地 preset 可能缺少内置 skill 或继承不兼容的 report 注册，因此发布验证会运行随附路径，而不是把本地覆盖视为发布产物。
