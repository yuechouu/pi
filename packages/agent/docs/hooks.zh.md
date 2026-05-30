# AgentHarness Hooks 设计

最终设计。

## 核心模型

事件将结果类型作为类型幻影（phantom）携带：

```ts
declare const HookResult: unique symbol;

interface HookEvent<TType extends string, TResult = void> {
    type: TType;
    readonly [HookResult]?: TResult;
}

type ResultOf<E> = E extends { readonly [HookResult]?: infer R } ? R : void;

type HookHandler<E, Ctx> = (
    event: E,
    ctx: Ctx,
    signal?: AbortSignal,
) => ResultOf<E> | void | Promise<ResultOf<E> | void>;

type HookObserver<E, Ctx> = (
    event: E,
    ctx: Ctx,
    signal?: AbortSignal,
) => void | Promise<void>;
```

示例：

```ts
interface ContextEvent extends HookEvent<"context", { messages?: AgentMessage[] }> {
    type: "context";
    messages: AgentMessage[];
}

interface ToolCallEvent extends HookEvent<"tool_call", { block?: boolean; reason?: string }> {
    type: "tool_call";
    toolName: string;
    input: Record<string, unknown>;
}

interface MessageEndEvent extends HookEvent<"message_end"> {
    type: "message_end";
    message: AgentMessage;
}
```

没有结果映射表。没有规范表。事件类型定义自己的结果。

## Hooks 接口

```ts
interface AgentHarnessHooks<E extends HookEvent<string, unknown>, Ctx> {
    context: Ctx;

    setContext(ctx: Ctx): void;

    observe(handler: HookObserver<E, Ctx>): () => void;

    on<TType extends E["type"]>(
        type: TType,
        handler: HookHandler<Extract<E, { type: TType }>, Ctx>,
    ): () => void;

    emit<TEvent extends E>(
        event: TEvent,
        signal?: AbortSignal,
    ): Promise<ResultOf<TEvent> | undefined>;

    addCleanup(cleanup: () => void | Promise<void>): () => void;

    clear(): Promise<void>;
    dispose(): Promise<void>;
}
```

重要的划分：

- `observe()` 看到所有事件，只读，返回值被忽略
- `on(type, handler)` 参与该事件的语义
- `emit(event)` 是 `AgentHarness` 唯一调用的东西
- `clear()` 移除观察者/处理器并运行清理

## 默认实现内部

```ts
class DefaultAgentHarnessHooks<E extends HookEvent<string, unknown>, Ctx>
    implements AgentHarnessHooks<E, Ctx> {
    context: Ctx;

    private observers = new Set<HookObserver<E, Ctx>>();
    private handlers = new Map<string, Set<HookHandler<any, Ctx>>>();
    private cleanups = new Set<() => void | Promise<void>>();

    constructor(ctx: Ctx) {
        this.context = ctx;
    }

    setContext(ctx: Ctx): void {
        this.context = ctx;
    }

    observe(handler: HookObserver<E, Ctx>): () => void {
        this.observers.add(handler);
        return () => this.observers.delete(handler);
    }

    on(type, handler): () => void {
        let handlers = this.handlers.get(type);
        if (!handlers) {
            handlers = new Set();
            this.handlers.set(type, handlers);
        }
        handlers.add(handler);
        return () => handlers.delete(handler);
    }

    async emit(event, signal?) {
        for (const observer of this.observers) {
            await observer(event, this.context, signal);
        }

        switch (event.type) {
            case "context":
                return this.emitContext(event, signal);
            case "before_provider_request":
                return this.emitBeforeProviderRequest(event, signal);
            case "before_provider_payload":
                return this.emitBeforeProviderPayload(event, signal);
            case "before_agent_start":
                return this.emitBeforeAgentStart(event, signal);
            case "tool_call":
                return this.emitToolCall(event, signal);
            case "tool_result":
                return this.emitToolResult(event, signal);
            case "session_before_compact":
            case "session_before_tree":
                return this.emitFirstCancelOrLast(event, signal);
            default:
                await this.emitObservationHandlers(event, signal);
                return undefined;
        }
    }
}
```

内部转换在实现内部是可接受的，因为 `Map<string, ...>` 丢失了特异性。公共 API 保持类型化。

## 变更语义

### 观察

```ts
await hooks.emit({ type: "message_end", message }, signal);
```

观察者运行。`message_end` 处理器运行。返回值被忽略，除非该事件后来获得结果类型。

### 上下文变换

处理器按顺序运行。每个看到当前消息。

```ts
let current = event;

for (const handler of handlers("context")) {
    const result = await handler(current, ctx, signal);
    if (result?.messages) {
        current = { ...current, messages: result.messages };
    }
}

return current.messages === event.messages ? undefined : { messages: current.messages };
```

### Provider 请求/载荷

顺序变换。每个处理器看到前一个输出。

```ts
let current = event;

for (const handler of handlers("before_provider_payload")) {
    const result = await handler(current, ctx, signal);
    if (result !== undefined) {
        current = { ...current, payload: result.payload };
    }
}

return changed ? { payload: current.payload } : undefined;
```

### Agent 启动前

收集注入的消息，链式系统提示。

```ts
let systemPrompt = event.systemPrompt;
const messages = [];

for (const handler of handlers("before_agent_start")) {
    const result = await handler({ ...event, systemPrompt }, ctx, signal);
    if (result?.messages) messages.push(...result.messages);
    if (result?.systemPrompt !== undefined) systemPrompt = result.systemPrompt;
}

return messages.length || systemPrompt !== event.systemPrompt
    ? { messages, systemPrompt }
    : undefined;
```

### 工具调用

顺序执行，遇阻塞则提前退出。

```ts
for (const handler of handlers("tool_call")) {
    const result = await handler(event, ctx, signal);
    if (result?.block) return result;
}
```

### 工具结果

顺序补丁累积。每个处理器看到当前已修补的结果。

```ts
let current = event;
let modified = false;

for (const handler of handlers("tool_result")) {
    const result = await handler(current, ctx, signal);
    if (!result) continue;

    current = {
        ...current,
        content: result.content ?? current.content,
        details: result.details ?? current.details,
        isError: result.isError ?? current.isError,
    };

    modified = true;
}

return modified
    ? { content: current.content, details: current.details, isError: current.isError }
    : undefined;
```

### Session 前置事件

顺序执行，遇取消则提前退出。

```ts
let last;

for (const handler of handlers(event.type)) {
    const result = await handler(event, ctx, signal);
    if (!result) continue;
    last = result;
    if (result.cancel) return result;
}

return last;
```

## Harness 用法

Harness 只做这些：

```ts
await this.hooks.emit(event, signal);
```

或：

```ts
const result = await this.hooks.emit({ type: "context", messages }, signal);
return result?.messages ?? messages;
```

Harness 不存储处理器、链式监听器或了解扩展策略。

## 上下文

上下文是普通对象，不会在每次 emit 时重建。

```ts
const hooks = new CodingAgentHooks({
    harness: harnessFacade,
    session: sessionFacade,
    ui: noUiFacade,
});
```

后来：

```ts
hooks.setContext({
    ...hooks.context,
    ui: tuiFacade,
});
```

对于动态状态，优先使用稳定的门面/方法而非 getter 迷宫：

```ts
interface CodingAgentHookContext {
    harness: HarnessFacade;
    session: SessionFacade;
    ui: UiFacade;
    models: ModelFacade;
}
```

每次运行的 `signal` 作为第三个处理器参数传递。

## 扩展加载（后续）

扩展加载可以与 harness 并存并构造 hooks：

```ts
const hooks = await loadExtensions({
    paths,
    context,
    hooks: new CodingAgentHooks(context),
});
const harness = new AgentHarness({ ..., hooks });
```

加载器注册到 hooks：

```ts
hooks.on("context", handler);
hooks.on("tool_call", handler);
hooks.addCleanup(cleanup);
```

重载：

```ts
await hooks.clear();
const nextHooks = await loadExtensions(...);
harness.setHooks(nextHooks); // 仅在空闲时支持
```

## 需要注意的问题

### 1. 错误策略必须明确

现有 coding-agent 捕获扩展错误、报告并继续。新 hooks 需要相同的策略，可能是：

```ts
errorMode: "continue" | "throw"
onError(error)
```

对于 coding-agent，默认应为 `"continue"`。

### 2. 来源元数据很重要

现有运行器知道哪个扩展产生了错误/资源/工具。普通的 `on()` 会丢失这些信息，除非我们添加注册元数据或作用域。

可能需要：

```ts
const scope = hooks.createScope({ sourceInfo });
scope.on("context", handler);
scope.addCleanup(...);
```

或 `on(type, handler, { sourceInfo })`。

### 3. 一些扩展能力是注册表，而非 hooks

这些不受 `emit()` 覆盖，应保留在 `CodingAgentHooks` 或扩展宿主上的注册表：

- 工具
- 命令
- 快捷键
- 标志
- 消息渲染器
- Provider 注册
- OAuth 提供者
- 自定义模型提供者

这没问题。它们不属于 `AgentHarness`。

### 4. 现有 coding-agent 事件可以被表示

以下没有阻碍：

- `context`
- `before_provider_request`
- `after_provider_response`
- `before_agent_start`
- `message_end`
- `tool_call`
- `tool_result`
- `input`
- `user_bash`
- `resources_discover`
- `session_before_*`
- `session_*`
- 模型/thinking 选择事件
- agent/turn/message/tool 生命周期事件

它们成为 `CodingAgentHooks` 处理的额外事件类型。

### 5. 需要保留完全相同的旧语义

移植 coding-agent 时，特殊情况必须复制：

- `input`：变换链，`handled` 短路
- `user_bash`：第一个有意义的结果获胜
- `message_end`：替换必须保持相同角色
- `before_agent_start`：`ctx.getSystemPrompt()` 必须反映当前链式提示
- `resources_discover`：聚合路径并保留扩展来源
- `tool_call`：参数变更对后续处理器可见
- `tool_result`：后续处理器看到先前的补丁

设计允许所有这些，但默认/coding hooks 实现必须编码这些行为。

### 6. `emit()` switch 可能遗漏自定义变更事件

如果子类添加了产生结果的事件但忘记覆盖 `emit()`，它将表现为观察性事件。测试应能捕获这个问题。如果这变得容易出错，可以稍后添加受保护的策略注册表，但最初不需要。

### 7. 观察者语义有意限制

观察者看到原始发出的事件一次。它们不看到每个中间变更。如果需要最终变换状态，发出单独的最终事件或使用事件特定的处理器。

## 结论

此设计可以实现新的 coding-agent。它比当前运行器更简单，保持 harness 清洁，只要 `CodingAgentHooks` 添加来源感知的作用域、注册表、清理和精确的旧事件语义，就能保留重要的扩展能力。
