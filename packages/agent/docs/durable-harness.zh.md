# 持久化 AgentHarness 和 Session 设计

持久化 AgentHarness / session 设计说明。

## 框架

完全持久化的 `AgentHarness` 本身不太现实，因为重要依赖是宿主应用提供的运行时 JS：

- 工具实现
- 模型/认证提供者
- 扩展和 hook 处理器
- 资源加载器
- 系统提示回调/修饰器

工具注册表是运行时依赖。Harness 应持久化可序列化的工具配置（如活跃工具名称），而非具体工具实现。

实际目标是**半持久化 harness**：

- session 是持久的仅追加状态树
- harness 将其拥有的状态持久化到 session 条目中
- 宿主应用负责在恢复时重新创建不可持久化的依赖
- 恢复从持久化边界重新开始，而非从进行中的 provider 流

## Session 拥有持久状态

将 session 视为所有持久的 agent 状态，而不仅仅是 transcript 历史。

现有 session 状态已包含 harness 状态：

- 模型变更
- Thinking 级别变更
- 活跃工具变更
- 叶子条目
- 标签
- 压缩和分支摘要
- 自定义消息和自定义条目

这表明继续使用一个持久 session 日志，而非添加 harness 侧车文件。侧车对于大 blob 可能仍有用，但 session 条目应保持为真实来源引用。

## 恢复时应用必须提供什么

应用必须重新创建兼容的运行时依赖：

- 模型注册表/模型对象
- 工具注册表
- 扩展集、版本和排序
- 资源加载器
- 系统提示提供者/hooks
- 认证提供者
- 应用特定的 hooks

Harness 可以在可用时验证稳定的 ID/版本/哈希，但它本身无法序列化这些依赖。

## 运行时配置和恢复

构造函数选项保持为明确的运行时配置，不读取 session 状态。构造函数中隐藏的异步恢复会使失败处理变得模糊。

未来的异步构建器/工厂应负责持久恢复：

```ts
const harness = await AgentHarness.builder()
    .env(env)
    .session(session)
    .model(defaultModel)
    .tools(runtimeTools)
    .defaultActiveTools(["read", "edit"])
    .restore({ missingActiveTools: "fail" });
```

`restore()` 应读取活跃分支，规约持久 harness 配置，为缺失条目应用默认值，验证应用提供的运行时依赖，构造 harness，并可选地在构造后发出 `source: "restore"` 更新事件。

对于活跃工具：

- `active_tools_change` 条目是分支作用域的持久配置
- 如果分支上没有 `active_tools_change`，恢复使用构建器默认值，或在未提供默认活跃名称时使用所有注册工具
- 活跃工具名称必须唯一
- 工具注册表名称必须唯一
- 缺失的恢复活跃工具名称应默认使恢复失败；宽松的丢弃/禁用策略可以稍后显式添加
- 具体工具绝不从 session 恢复；宿主应用必须提供兼容的工具

## Harness 应持久化什么

最小有用的持久性条目：

- 分支作用域的活跃工具名称
- 排队的 steer/followUp/nextTurn 消息
- 绑定到 turn 的队列消费
- 活跃操作期间接受的待处理 session 写入
- 待处理写入应用状态
- 操作开始/完成/中断
- turn 开始/完成
- Provider 请求开始/完成（如需恢复诊断）
- 工具调用开始/完成（如需安全工具恢复）

潜在条目：

```ts
type DurableHarnessEntry =
    | QueueEnqueuedEntry
    | QueueConsumedEntry
    | PendingWriteEnqueuedEntry
    | PendingWriteAppliedEntry
    | OperationStartedEntry
    | OperationFinishedEntry
    | OperationInterruptedEntry
    | TurnStartedEntry
    | TurnFinishedEntry
    | ProviderRequestStartedEntry
    | ProviderRequestFinishedEntry
    | ToolCallStartedEntry
    | ToolCallFinishedEntry;
```

每个接受的变更必须在公共 API 解析之前持久化。

## 恢复模型

启动时：

1. 宿主应用注册工具/模型/扩展/资源/认证/hooks
2. Harness 打开 session
3. Harness 将 session 条目规约为：
   - 当前叶子
   - 对话分支
   - Harness 配置（包括活跃工具名称）
   - 队列
   - 待处理写入
   - 活跃操作/turn/工具状态
4. Harness 验证必需的运行时依赖（包括恢复的活跃工具名称是否符合应用提供的工具注册表）
5. Harness 协调未完成的操作状态

Provider 流不可恢复。恢复只能从持久边界重试或标记操作中断。

## 恢复策略

默认保守策略：

- 未完成的 agent turn：标记中断，保留持久队列/待处理写入，返回空闲
- 未完成的 provider 请求：标记中断，不自动重试
- 未完成的工具调用：追加中断/错误工具结果，仅在工具声明幂等/可重试时重试
- 未完成的压缩：如无压缩条目则重新运行
- 未完成的分支摘要/树导航：如安全则重新运行/应用缺失的摘要或叶子条目

可选策略：

```ts
recovery: "mark_interrupted" | "retry_unfinished"
```

`retry_unfinished` 必须围绕非幂等工具调用进行保护。

## 关键场景

### 队列

- `queue_enqueued` 前崩溃：消息未被接受
- `queue_enqueued` 后崩溃：消息被恢复
- 队列排空后但在持久 turn 记录前崩溃：有丢失/重复风险
- **必需不变量**：消费的队列 ID 必须在 `turn_started` 或等价物中记录后才算消费

### 待处理写入

- `pending_write_enqueued` 前崩溃：写入未被接受
- 入队后应用前崩溃：恢复应用它
- 应用后但在应用标记前崩溃：确定性目标条目 ID 让恢复能检测条目是否已存在并标记为已应用

### Agent 循环 turn

- Provider 请求前崩溃：重试或标记中断
- Provider 请求期间崩溃：默认标记中断
- Provider 响应后但在 assistant 消息持久化前崩溃：响应丢失，除非 provider 结果被日志记录
- Assistant 消息持久化后崩溃：从持久消息恢复

### 工具调用

- 工具调用开始后但在结果前崩溃：外部副作用可能已发生
- 默认恢复不应重试非幂等工具
- 工具调用需要稳定的 ID 和重试安全元数据以支持自动恢复

### 压缩

- 摘要生成前崩溃：重新运行准备/摘要
- 生成摘要后但在压缩条目前崩溃：重新运行，除非摘要被日志记录
- 压缩条目后崩溃：操作完成，如缺少则追加完成标记

### 分支摘要/树导航

- 摘要前崩溃：重新运行或标记中断
- 摘要条目后叶子条目前崩溃：追加缺失的叶子条目
- 叶子条目后崩溃：操作完成，如缺少则追加完成标记

## 最小可行探索

1. 添加持久队列条目
2. 添加带确定性目标 ID 的持久待处理写入条目
3. 添加操作开始/完成/中断条目
4. 添加带消费队列 ID 的 turn 开始
5. 通过规约 session 日志进行恢复
6. 默认标记未完成的 agent turn 为中断
7. 仅在无最终条目时重新运行未完成的压缩/树操作
8. 不重试未完成的工具调用，除非工具元数据表示可重试

## 开放问题

- 哪些剩余的 harness 配置条目应首先进入 session：资源、流选项、系统提示引用？
- 已解析的系统提示文本是否应按 turn 快照用于审计/调试？
- 恢复时是否要求严格的依赖 ID/版本匹配？
- 应记录多少 provider 请求数据？
- 恢复应追加用户可见的 assistant 中断消息还是仅内部操作条目？
- 存储是否支持在恢复期间截断最终的部分 JSONL 行？
