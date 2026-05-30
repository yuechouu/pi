# AgentHarness 生命周期

`AgentHarness` 是底层 agent 循环之上的编排层。它负责 session 持久化、运行时配置、资源解析、操作锁和面向扩展的变更语义。

本文档描述当前方向和已实现的行为。部分扩展/session 门面细节是计划中的，会明确标注。

## 最终生命周期目标

Harness 监听器和 hooks 应该能够闭包捕获 `AgentHarness` 实例，并从任何文档允许的事件中调用公共 harness API。这些调用不得：

- 破坏进行中的 turn 快照
- 重新排序持久化的 transcript 条目
- 丢失待处理的写入
- 导致结算死锁
- 使 harness 处于错误的阶段

预期规则是：

- 结构操作在忙碌时仍被拒绝
- 队列操作在文档记录的 turn 安全点被接受
- 运行时配置设置器更新未来的快照，而不变更当前 provider 请求
- 忙碌时进行的 session 写入被持久排队，并按确定性顺序刷新
- getter 返回最新的 harness 配置，而非进行中的快照
- 监听器/hooks 目前不接收门面；如果它们闭包捕获原始 harness 并在活跃运行期间调用 `waitForIdle()` 等结算 API，可能导致死锁。未来的门面应暴露 `runWhenIdle()` 替代

`AssistantMessageStream` 已经将 provider 传输流（如 SSE 或 websocket 读取）与下游事件消费解耦。因此 harness 可以等待监听器、扩展钩子、持久化和保存点工作，而不会阻塞 provider 传输读取器或重新引入临时事件队列。生命周期代码应优先使用 harness 边界处的显式等待顺序，而非 fire-and-forget 的 hook/事件结算。

最终的生命周期加固应通过广泛的监听器/hook 重入测试套件来验证这些保证。

## 错误处理

当前的划分是：

- 底层能力和辅助函数使用 `Result<TValue, TError>`，预期失败被包含且不得抛出，例如 `ExecutionEnv`、文件系统/shell 操作、shell 输出捕获、资源加载和压缩辅助函数
- 高层变更/编排 API（如 `Session` 和 `AgentHarness`）使用 reject/throw 而非返回可忽略的裸结果
- 公共 `AgentHarness` 失败在实际可行时标准化为 `AgentHarnessError`，子系统错误保留为 `cause`

Harness 事件观察已提交的状态。公共变更器在实际可行时验证必需的输入和持久化，然后等待通知。如果 hook 或订阅者在提交后失败，状态变更不会回滚，公共方法以 `AgentHarnessError` 代码 `"hook"` 拒绝。

## 状态模型

Harness 将状态分为四类。

### Harness 配置

Harness 配置是应用或扩展设置的最新运行时配置：

- 模型
- Thinking 级别
- 工具
- 活跃工具名称
- 资源
- 流选项
- 系统提示或系统提示提供者

Getter 返回 harness 配置。它们不返回进行中的 provider 请求使用的快照。

Setter 立即更新 harness 配置，包括在 turn 进行中时。变更影响下一个 turn 快照，而非当前运行的 provider 请求。

`setResources()` 接受具体资源，每次调用时发出 `resources_update`，包含浅拷贝的当前和先前资源。应用负责从磁盘或其他来源加载/重载资源，并应使用新值调用 `setResources()`。

`getResources()` 返回浅拷贝的当前资源。它是实时配置读取，而非最后一个 turn 快照。

### Turn 快照

Turn 快照是用于一次 LLM turn 的具体状态。它由 `createTurnState()` 创建，包含：

- 持久化的 session 消息
- 已解析的资源
- 已解析的系统提示
- 模型
- Thinking 级别
- 所有工具
- 活跃工具
- 流选项
- 派生的 session id

静态选项值直接使用。系统提示提供者回调在每次 `createTurnState()` 调用时执行一次。该 turn 的所有逻辑使用相同的快照。

资源数组在创建快照时浅拷贝。单个技能和提示模板对象不深拷贝。

流选项在创建快照时浅拷贝。`headers` 和 `metadata` 映射浅拷贝；其值不深拷贝。`getApiKeyAndHeaders()` 的凭据在每次 provider 请求时解析，以便过期令牌可以刷新，但配置的流选项和派生的 session id 来自当前 turn 快照。

### Session

Session 仅包含持久化的条目。Session 读取返回持久状态，不包含排队的写入。

Session 存储实现必须将叶子变更持久化为 `leaf` 条目。`setLeafId()` 不是仅内存的光标更新；它追加一个持久条目，其 `targetId` 是活跃树叶子或 `null`（表示根）。重新打开存储必须从最新的持久叶子影响条目重建当前叶子。

### 待处理的 session 写入

操作活跃时请求的 session 写入被排队为待处理的 session 写入。待处理写入基于 session 条目形状，不包含生成字段（`id`、`parentId`、`timestamp`）。

待处理的 session 写入始终被持久化。它们在保存点、操作结算和失败清理时刷新。

公共的待处理写入/session 门面 API 已计划但尚未实现。

## 操作阶段

Harness 有明确的阶段：

```ts
type AgentHarnessPhase = "idle" | "turn" | "compaction" | "branch_summary" | "retry";
```

结构操作要求 `phase === "idle"`，并在第一个 `await` 之前同步设置阶段：

- `prompt`
- `skill`
- `promptFromTemplate`
- `compact`
- `navigateTree`

在 harness 非空闲时启动另一个结构操作会以 `AgentHarnessError` 代码 `"busy"` 拒绝。

以下操作在 turn 期间适当时候被允许：

- `steer`
- `followUp`
- `nextTurn`
- `abort`
- 运行时配置设置器

阶段/结算语义仍为临时性的，需要完整的生命周期审查。

## Turn 执行

`prompt`、`skill` 和 `promptFromTemplate` 遵循相同流程：

1. 断言空闲并将阶段设置为 `"turn"`
2. 使用 `createTurnState()` 创建 turn 快照
3. 从该快照派生调用文本
4. 使用 `executeTurn()` 执行 turn

`skill` 和 `promptFromTemplate` 从传递给 turn 的相同快照解析其资源。它们不单独解析资源。

`steer`、`followUp` 和 `nextTurn` 接受文本加可选图像，内部创建用户消息。`nextTurn` 消息在下一个用户发起的 turn 中插入到新用户消息之前。

队列模式是实时的，而非 turn 快照：

- `getSteeringMode()` / `setSteeringMode()`
- `getFollowUpMode()` / `setFollowUpMode()`

在运行期间更改队列模式影响下一次队列排空。队列排空发生在安全点。

## 保存点

保存点发生在 assistant turn 及其 tool-result 消息完成后。

在保存点，harness：

1. 在该 turn 的 agent 发出消息之后刷新待处理的 session 写入
2. 如果底层循环可能继续，创建新的 turn 快照
3. 在下一个 provider 请求之前应用新的上下文/模型/thinking 级别/流选项/session-id 状态

这使得 turn 期间进行的模型、thinking 级别、工具、资源、流选项和系统提示变更影响同一运行中的下一个 turn，同时绝不变更进行中的 provider 请求。因为 provider 传输读取已被 `AssistantMessageStream` 解耦，保存点工作和 hook 结算可以直接等待以保持 transcript/session 顺序确定性。循环回调不会在保存点重新创建。

底层循环在 provider 边界将 harness `ThinkingLevel` 转换为 provider `reasoning`：

- `"off"` -> `undefined`
- 所有其他 thinking 级别直接传递

在 `agent_end` 时不需要状态刷新，除了刷新剩余的待处理 session 写入和清除操作阶段。确切的 `settled` 事件时序仍在审查中。

如果系统提示回调在启动 `prompt`、`skill` 或 `promptFromTemplate` 时抛出，操作以 `AgentHarnessError` 拒绝，harness 返回空闲。如果它在 `prepareNextTurn` 创建的保存点快照中抛出，底层 agent 运行记录一个 assistant 错误消息。

## Hooks 和事件

目标 hook 系统在 [hooks.md](./hooks.md) 中描述。

总结：

- `AgentHarness` 发出类型化的 hook 事件并消费类型化的结果
- 单个 hooks 实现负责注册、清理、来源和结果规约器
- 观察和变更 hooks 使用一个事件特定的 `on()` API；事件结果类型决定处理器是否可以返回结果
- 产生结果的事件由类型化的规约器表规约；应用特定 hooks 仅为应用特定的结果产生事件添加规约器
- Hook 注册来源是注册上的侧车元数据。资源和工具来源属于应用特定的具体值类型
- Hook 上下文应是门面的普通对象，而非原始内部或延迟绑定的 getter 迷宫

事件载荷描述正在发生什么。Harness getter 描述未来快照的最新配置。Hook 和监听器结算应在可能的情况下按生命周期顺序等待；传输背压由 `AssistantMessageStream` 在 harness 之下处理，因此 harness 不需要单独的异步事件队列来保持 SSE 或 websocket 读取流动。

## 计划中的 Session 门面

扩展最终应通过 harness 作用域的 `HarnessSession` 门面与 session 交互，而非原始 session。门面应包装内部 session 并强制执行 harness 待处理写入排序语义。一旦实现，hooks 和事件监听器可以接收暴露完整 `AgentHarness` 加 session 门面的上下文，而不直接访问无序的原始 session 写入。

计划的读取语义：

- 读取委托给持久化的 session 状态
- 读取不包含排队的待处理写入

计划的写入语义：

- 空闲时：立即持久化
- 忙碌时：入队为待处理 session 写入

计划的诊断 API 可能显式暴露待处理写入：

```ts
getPendingWrites(): readonly PendingSessionWrite[]
```

Agent 发出的消息在 `message_end` 时持久化以保持 transcript 顺序。待处理的扩展/session 写入在保存点这些消息之后刷新。

## 中止

中止在 turn 期间被允许。它中止底层运行并清除 steering/follow-up 队列。

中止不清除 `nextTurn` 消息。使用 `nextTurn()` 排队的消息在中止后存活，并在下一个用户发起的 turn 中插入到用户消息之前。

中止不丢弃待处理的 session 写入。待处理写入在到达下一个保存点、`agent_end` 或操作失败清理时刷新。

中止屏障语义仍需审计。

## 压缩和树导航

压缩和树导航是结构化的 session 变更。

它们仅在空闲时被允许，不被排队。它们操作持久化的 session 状态。下一个 prompt 创建新的 turn 快照。

分支摘要是树导航操作的一部分。

自动压缩和重试决策点尚未在 `AgentHarness` 中实现。

## 测试组织

Harness 测试应按领域划分，而非集中在一个大文件中。

当前结构：

- `packages/agent/test/harness/agent-harness.test.ts`：核心生命周期和公共 API 行为
- `packages/agent/test/harness/agent-harness-stream.test.ts`：流选项和 provider hook 语义

建议的未来结构：

- `agent-harness-resources.test.ts`：资源快照/加载语义
- `agent-harness-tools.test.ts`：工具注册 getter、活跃工具语义和更新事件
- `agent-harness-lifecycle.test.ts`：阶段/保存点/settled/重入行为

使用 `pi-ai` faux provider（`registerFauxProvider`、`fauxAssistantMessage`）进行确定性的 harness/provider 测试。Faux 响应工厂可以检查 `StreamOptions`、调用 `options.onPayload`，并返回脚本化的 assistant 消息，无需真实 provider API 或网络访问。

Harness 覆盖率与默认包测试运行分开配置：

```bash
npm run test:harness
npm run coverage:harness
```

## 实现待办事项

此列表跟踪将 `AgentHarness` 视为可迁移就绪之前的剩余工作。

### 1. 添加明确的工具注册读取/更新语义

状态：进行中

已完成：
- 添加了 `setTools(tools, activeToolNames?)`
- 添加了 `setActiveTools(toolNames)`
- 无效的活跃工具名称以 `AgentHarnessError` 拒绝
- 通过 `AgentHarness<TSkill, TPromptTemplate, TTool>` 添加了通用应用工具形状
- 导出了 `QueueMode`
- 添加了实时 `getSteeringMode()` / `setSteeringMode()` 和 `getFollowUpMode()` / `setFollowUpMode()`
- 添加了 `getTools()` 和 `getActiveTools()`
- 添加了 `tools_update` 可观测性事件
- 活跃工具变更持久化为分支作用域的 `active_tools_change` 条目
- 重复工具名称和重复活跃工具名称被拒绝

剩余：无

### 2. 设计每个 `AgentHarness` 的模型注册表

状态：计划中

剩余：
- 决定应用如何提供模型注册表
- 决定 harness 存储具体 `Model` 对象、模型引用还是两者
- 验证模型选择是否符合注册表
- 定义活跃 turn 和保存点期间的模型变更语义

### 3. 完整的 `AgentHarness` 生命周期/状态审查

状态：进行中

已完成：
- 移除了构造函数中的 `void syncFromTree()`、`syncFromTree()`、`liveOperationId` 和 `shell()`
- 添加了 `createTurnState()`、`applyTurnState()` 和 `executeTurn()`
- 用明确的 `phase` 替代布尔空闲状态
- 保存点刷新上下文、模型、thinking 级别、流选项和 session 快照状态
- 待处理 session 写入使用不包含生成字段的 session 条目形状
- 公共 harness 失败将子系统原因标准化为 `AgentHarnessError`
- `setLeafId()` 持久化 `leaf` 条目使树导航在存储重新打开后存活

剩余：
- 最终确定 phase/idle 语义
- 审计 `settled` 是否可能过早触发
- 审计 `abort()` 屏障语义
- 实现自动压缩决策点
- 实现重试处理

### 4. 实现通用 hook/事件扩展机制

状态：在 [hooks.md](./hooks.md) 中设计，未实现

剩余：
- 添加 `HookEvent`、`ResultOf`、注册选项和单个 `AgentHarnessHooks` 实现
- 将结果链从 `AgentHarness` 移出到规约函数
- 定义初始 harness/上下文门面

### 5. 探索半持久化 harness/session 持久性

状态：计划中

已完成：
- 编写了持久性设计：[durable-harness.md](./durable-harness.md)

剩余：
- 决定 session 是否拥有所有持久 harness 状态
- 定义队列、待处理写入、操作、turn、provider 请求和工具调用的持久条目
- 定义应用提供的工具、模型、扩展、资源、hooks 和认证提供者的恢复要求
- 原型化基于规约器的 session 条目恢复

### 6. 最终生命周期加固套件

状态：计划中

剩余：
- 添加广泛的监听器/hook 重入测试
- 测试运行时配置设置器从低层生命周期事件和 harness 事件
- 测试 session 写入从监听器和 hooks
- 测试队列操作从 turn 事件、工具事件和 provider hooks
- 测试忙碌时拒绝的结构操作
- 测试通过成功、provider 错误、hook 错误、中止、压缩和树导航的阶段清理

### 7. 后续的 coding-agent 迁移计划

状态：计划中

剩余：
- 将 coding-agent 资源映射到有来源的加载器
- 保持应用层资源去重/来源在 harness 之外
- 适配扩展加载到未来的 hook/session 门面
- 保持 UI/session 行为在核心之外

---

## 已完成的实现待办事项

### 8. 从 `AgentHarness` 移除 `Agent` 依赖

状态：已完成

- `AgentHarness` 直接调用 `runAgentLoop()`
- Harness 拥有运行生命周期、中止控制器、队列排空、provider 流配置、事件规约、session 持久化、待处理写入刷新和保存点快照

### 9. 完成精选的 provider/流配置

状态：已完成

- 添加了精选的 `AgentHarnessOptions.streamOptions`、`getStreamOptions()` 和 `setStreamOptions()`
- 流选项、headers、metadata 和派生的 session id 按 turn 快照
- 实现了 `before_provider_request`、`before_provider_payload` 和 `after_provider_response` hooks

### 10. 完成底层 `Result` 清理

状态：已完成

- 添加了泛型 `Result<TValue, TError>` 加辅助函数
- 更新了 `ExecutionEnv` 和 `NodeExecutionEnv` 返回类型化的结果
- 拆分了文件系统和 shell 能力
- 将压缩和分支摘要辅助函数转换为类型化结果返回
- 添加了类型化的 session 错误和原因感知的公共 harness 错误标准化
