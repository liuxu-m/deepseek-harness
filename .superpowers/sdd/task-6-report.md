# Task 6 报告

## 已完成

- `code-mode-parent-child-control` 现在通过真实 `run_code` 分派一个 continuable child，并在 child report 后依次执行 `list_agents`、`get_agent_status`、`steer_agent`、`interrupt_agent` 与 `close_agent`。
- child 通过真实 `run_code` 调用 `report` 和 `wait_agent`；parent 的 interrupt/close 产生完整的 child lifecycle transcript。
- 场景为 child 独立固定了 prompt 与 tool-schema sidecar，并在 fixture 结构断言中检查 parent dispatch 顺序和 child 的 report、progress、steer、interrupt、closed 事件。
- close 后的 durable `subagent/closed` 广播使用 child scope carrier，保证 scoped child listener 存在时 root listener 仍能收到事件。
- 快照归一化仅将 `subagent/progress`、`subagent/steer-accepted`、`subagent/interrupt-requested` 和 `subagent/closed` 的易变 `data.occurredAt` 归零；其他事件载荷时间保持可见。
- 删除未被 Python SDK smoke 消费的孤立 `subagent-control.json` fixture。

## 验证

- `pnpm exec vitest run packages/test-support/acp-snapshot/tests/normalize.spec.ts --reporter=dot`：51 tests 通过。
- `pnpm exec vitest run packages/subagent/subagent/tests/continuation.spec.ts -t 'persists closed event after handle disposal with continuous sequence' --reporter=dot`：1 test 通过。
- `$env:DSH_SNAPSHOT='refresh'; pnpm exec vitest run --config vitest.snapshot.config.ts examples/acp-agent/tests/acp.snapshot.ts -t 'snapshot: code-mode-parent-child-control matches the expected outputs' --reporter=dot`：1 test 通过。
- 在暂时隔离未跟踪的过期 `packages/test-support/acp-snapshot/src/index.js` 后，`DSH_SNAPSHOT=replay` 的结构断言和场景比较均通过（2 tests）。该构建残留未纳入提交；干净工作树会解析 TypeScript source。
- `pnpm exec vitest run packages/sdk/client/tests` 首次出现不相关的 SIGKILL 300ms 退出超时；同一用例单独重试通过。

## 限制

- 工作树包含大量用户已有的未跟踪 build artifact；它们未被删除或提交。`acp-snapshot/src/*.js` 会在本地优先于 source 被解析，运行 source snapshot 时应先清理这些残留或使用干净工作树。
