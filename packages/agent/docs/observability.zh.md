# Pi 可观测性设计说明

## 目标

使 `packages/ai` 和 `packages/agent`/harness 可观测，而不依赖 OpenTelemetry、Sentry 或任何 APM 供应商。

Pi 应发出稳定的、结构化的生命周期事件。外部监听器可以将这些事件转换为 OTel spans、Sentry spans、日志、指标或自定义遥测。

## 心智模型

一个 trace 是一个因果工作树，例如一个用户 turn。

一个 span 是该树中的一个计时操作。它通常由 ID 表示，而非对象指针：

```ts
interface SpanRecord {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    name: string;
    startTime: number;
    endTime?: number;
    attributes: Record<string, unknown>;
    status: "ok" | "error";
}
```

示例树：

```text
traceId=t1 spanId=s1 parent=-  name=pi.agent.prompt
traceId=t1 spanId=s2 parent=s1 name=pi.agent.turn
traceId=t1 spanId=s3 parent=s2 name=pi.ai.provider.request
traceId=t1 spanId=s4 parent=s2 name=pi.agent.tool_call
traceId=t1 spanId=s5 parent=s4 name=pi.session.append_entry
```

## 异步上下文

JavaScript 有一个事件循环但多个异步链可以交错。单个全局 `currentContext` 在并发下会出错。

`AsyncLocalStorage` 是 Node 的异步延续等价于 `ThreadLocal`。它让并发操作保持不同的当前上下文：

```ts
await Promise.all([
    runWithPiContext({ userId: "alice" }, () => harness.prompt("A")),
    runWithPiContext({ userId: "bob" }, () => harness.prompt("B")),
]);
```

深层代码可以为活跃的异步链读取正确的当前上下文。

Pi 必须在 Node、Bun、browser、workers 和其他 JS 运行时中运行，所以 ALS 不能是核心抽象。它应该是一个运行时适配器。

## 核心设计

Pi 拥有一个小型的运行时无关的可观测性抽象：

```ts
export interface PiObservabilityContext {
    traceId?: string;
    currentSpanId?: string;
    userContext?: Record<string, unknown>;
}

export interface PiObservabilityEvent {
    type: "start" | "end" | "error" | "event";
    name: string;
    traceId: string;
    spanId?: string;
    parentSpanId?: string;
    timestamp: number;
    durationMs?: number;
    context?: Record<string, unknown>;
    payload?: Record<string, unknown>;
    error?: { name: string; message: string };
}

export interface PiObservability {
    getContext(): PiObservabilityContext | undefined;
    runWithContext<T>(context: PiObservabilityContext, fn: () => T): T;
    emit(event: PiObservabilityEvent): void;
    hasSubscribers(): boolean;
}
```

公共 API：

```ts
export function configurePiObservability(observability: PiObservability): void;
export function subscribePiObservability(listener: (event: PiObservabilityEvent) => void): () => void;
export function runWithPiContext<T>(userContext: Record<string, unknown>, fn: () => T): T;
export function traceOperation<T>(name: string, payload: Record<string, unknown>, fn: () => T): T;
```

`traceOperation()`：

1. 读取当前上下文
2. 如果缺少则创建 `traceId`
3. 创建新的 `spanId`
4. 使用当前 span 作为 `parentSpanId`
5. 发出 `start`
6. 在子上下文中运行回调
7. 发出 `end` 或 `error`
8. 出错时重新抛出

伪代码：

```ts
function traceOperation<T>(name: string, payload: Record<string, unknown>, fn: () => T): T {
    const parent = getContext();
    const traceId = parent?.traceId ?? createId();
    const spanId = createId();
    const parentSpanId = parent?.currentSpanId;

    const child = { ...parent, traceId, currentSpanId: spanId };

    emit({ type: "start", name, traceId, spanId, parentSpanId, timestamp: Date.now(), context: parent?.userContext, payload });

    return runWithContext(child, () => {
        try {
            const result = fn();
            // Promise 感知实现在 settlement 后发出 end/error
            emit({ type: "end", name, traceId, spanId, parentSpanId, timestamp: Date.now(), context: child.userContext, payload });
            return result;
        } catch (error) {
            emit({ type: "error", name, traceId, spanId, parentSpanId, timestamp: Date.now(), context: child.userContext, payload, error: serializeError(error) });
            throw error;
        }
    });
}
```

## 运行时适配器

核心包不应导入 Node 专有 API。

可能的实现：

- **Node 适配器**：`AsyncLocalStorage` 用于上下文，可选 `diagnostics_channel` 发布
- **Browser/workers 回退**：本地订阅者集合和有限/手动上下文传播
- **Bun/Deno 适配器**：使用运行时特定的异步上下文（如果可用）

对于 Node，诊断通道可用作被动事件总线：

```ts
import { channel } from "diagnostics_channel";
channel("pi.observability").publish(event);
```

订阅者可以创建 OTel/Sentry spans 而无需猴子补丁 pi。

## Pi 发出什么

Pi 发生了什么。它不直接创建 OTel/Sentry spans。

初始最小事件名称：

```text
pi.agent.prompt
pi.agent.skill
pi.agent.prompt_template
pi.agent.compaction
pi.agent.branch_navigation
pi.agent.session.append_entry
pi.ai.provider.request
```

每个操作发出：

```text
start
end
error
```

后续添加：

```text
pi.agent.turn
pi.agent.tool_call
pi.agent.queue_update
pi.ai.provider.retry
pi.ai.provider.first_token
pi.ai.provider.usage
pi.session.read
pi.session.write
```

## 最小插桩点

### packages/agent

包装：

- `AgentHarness.prompt()`
- `AgentHarness.skill()`
- `AgentHarness.promptFromTemplate()`
- `AgentHarness.compact()`
- `AgentHarness.navigateTree()`
- `Session.appendTypedEntry()` 或存储追加门面

示例：

```ts
return traceOperation(
    "pi.agent.prompt",
    {
        sessionId: turnState.sessionId,
        provider: turnState.model.provider,
        model: turnState.model.id,
        promptLength: text.length,
        imageCount: options?.images?.length ?? 0,
    },
    () => this.executeTurn(turnState, text, options),
);
```

Session 写入：

```ts
return traceOperation(
    "pi.agent.session.append_entry",
    { entryType: entry.type },
    async () => {
        await this.unwrap(this.storage.appendEntry(entry));
        return entry.id;
    },
);
```

### packages/ai

包装通用 provider 边界：

- `streamSimple()`
- `completeSimple()`

示例：

```ts
return traceOperation(
    "pi.ai.provider.request",
    {
        api: model.api,
        provider: model.provider,
        model: model.id,
        sessionId: options.sessionId,
        reasoning: options.reasoning,
    },
    () => actualStreamSimple(model, context, options),
);
```

结束/错误载荷可以包含安全元数据：

- 停止原因
- 状态码
- 重试次数
- 输入/输出/总 token 数
- 总成本
- 中止/超时标志

## 安全和脱敏

默认载荷必须是安全的。

默认安全：

- provider
- model
- API 标识符
- session id
- entry 类型
- tool name
- 状态码
- 停止原因
- token 计数
- 成本
- 持续时间

默认不安全：

- prompts
- completions
- tool 参数
- tool 结果
- shell 输出
- 文件内容
- provider 请求载荷
- provider 响应体
- API 密钥
- headers

内容捕获可以在以后通过明确的脱敏钩子选择启用。

## 监听器行为

可观测性绝不能影响 pi 执行。

订阅者错误应被吞掉或隔离。Harness hooks 是控制平面，可能影响执行；可观测性订阅者是被动的，绝不能影响执行。

## 用户上下文

用户可以将任意上下文与 turn 关联：

```ts
await runWithPiContext(
    {
        userId: "u123",
        orgId: "acme",
        region: "eu",
    },
    () => harness.prompt("fix this"),
);
```

该异步链内发出的每个事件都包含该上下文：

```ts
{
    type: "start",
    name: "pi.ai.provider.request",
    traceId: "t1",
    spanId: "s3",
    parentSpanId: "s1",
    context: {
        userId: "u123",
        orgId: "acme",
        region: "eu",
    },
    payload: {
        provider: "anthropic",
        model: "claude-sonnet-4",
    },
}
```

OTel 适配器可以将其映射为 span 属性。Sentry 适配器可以将其映射为 Sentry 上下文/spans。自定义用户可以记录 JSON。

## 包结构

最小初始包：

```text
packages/observability
    运行时无关的上下文 + traceOperation + subscribe
```

然后：

```text
packages/ai
    发出 pi.ai.* 事件

packages/agent
    发出 pi.agent.* / pi.session.* 事件
```

可选后续：

```text
packages/observability-node
    AsyncLocalStorage + diagnostics_channel 桥接

packages/otel
    订阅 pi 事件并创建 OpenTelemetry spans
```

## 核心理念

Pi 定义稳定的、安全的事件契约。适配器定义事件去向。

这使得 ai/harness 可观测，而不将核心包绑定到 OTel、Sentry、Node 专有 API 或猴子补丁。
