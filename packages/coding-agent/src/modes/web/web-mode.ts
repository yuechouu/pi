/**
 * Web mode: HTTP server with WebSocket for browser-based UI.
 *
 * Serves a single-page app and provides:
 * - WebSocket endpoint mapping to the RPC protocol
 * - REST API endpoints for state/messages
 * - Static file serving for the frontend
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { type Theme, theme } from "../interactive/theme/theme.ts";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
	RpcSlashCommand,
} from "../rpc/rpc-types.ts";
import { SessionManager } from "../../core/session-manager.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface WebModeOptions {
	port?: number;
	register?: string;  // dashboard host:port to register with
}

/**
 * Run in Web mode.
 * Starts an HTTP server with WebSocket support for browser-based interaction.
 */
export async function runWebMode(
	runtimeHost: AgentSessionRuntime,
	options: WebModeOptions = {},
): Promise<never> {
	const port = options.port ?? 3210;
	let session = runtimeHost.session;

	// Pending extension UI requests
	const pendingExtensionRequests = new Map<
		string,
		{ resolve: (value: any) => void; reject: (error: Error) => void }
	>();

	// Connected WebSocket clients
	const clients = new Set<WebSocket>();

	// Known agents (registered via /api/register or --register flag)
	const knownAgents: Array<{ host: string; name: string; cwd: string; port?: number }> = [];

	// Register with a dashboard if --register is specified
	const registerWithDashboard = async (dashboardUrl: string) => {
		try {
			const agentHost = `localhost:${port}`;
			const resp = await fetch(`http://${dashboardUrl}/api/register`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ host: agentHost, name: `Agent :${port}`, cwd: process.cwd(), port }),
			});
			if (resp.ok) {
				console.log(`[Web] Registered with dashboard at ${dashboardUrl}`);
			} else {
				console.error(`[Web] Failed to register with dashboard: ${resp.status}`);
			}
		} catch (err) {
			console.error(`[Web] Could not reach dashboard at ${dashboardUrl}: ${err instanceof Error ? err.message : err}`);
		}
	};

	const broadcast = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		const data = JSON.stringify(obj);
		if (clients.size > 0) {
			console.log(`[Web] Broadcasting to ${clients.size} clients: ${(obj as any).type || 'response'}`);
		}
		for (const ws of clients) {
			if (ws.readyState === ws.OPEN) {
				ws.send(data);
			}
		}
	};

	const success = <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		data?: object | null,
	): RpcResponse => {
		if (data === undefined) {
			return { id, type: "response", command, success: true } as RpcResponse;
		}
		return { id, type: "response", command, success: true, data } as RpcResponse;
	};

	const error = (id: string | undefined, command: string, message: string): RpcResponse => {
		return { id, type: "response", command, success: false, error: message };
	};

	// Extension UI context (same as RPC mode)
	function createDialogPromise<T>(
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		request: Record<string, unknown>,
		parseResponse: (response: RpcExtensionUIResponse) => T,
	): Promise<T> {
		if (opts?.signal?.aborted) return Promise.resolve(defaultValue);
		const id = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;
			const cleanup = () => {
				if (timeoutId) clearTimeout(timeoutId);
				opts?.signal?.removeEventListener("abort", onAbort);
				pendingExtensionRequests.delete(id);
			};
			const onAbort = () => { cleanup(); resolve(defaultValue); };
			opts?.signal?.addEventListener("abort", onAbort, { once: true });
			if (opts?.timeout) {
				timeoutId = setTimeout(() => { cleanup(); resolve(defaultValue); }, opts.timeout);
			}
			pendingExtensionRequests.set(id, {
				resolve: (response: RpcExtensionUIResponse) => { cleanup(); resolve(parseResponse(response)); },
				reject,
			});
			broadcast({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
		});
	}

	const createExtensionUIContext = (): ExtensionUIContext => ({
		select: (title, options, opts) =>
			createDialogPromise(opts, undefined, { method: "select", title, options, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),
		confirm: (title, message, opts) =>
			createDialogPromise(opts, false, { method: "confirm", title, message, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false,
			),
		input: (title, placeholder, opts) =>
			createDialogPromise(opts, undefined, { method: "input", title, placeholder, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),
		notify(message: string, type?: "info" | "warning" | "error"): void {
			broadcast({ type: "extension_ui_request", id: crypto.randomUUID(), method: "notify", message, notifyType: type } as RpcExtensionUIRequest);
		},
		onTerminalInput(): () => void { return () => {}; },
		setStatus(key: string, text: string | undefined): void {
			broadcast({ type: "extension_ui_request", id: crypto.randomUUID(), method: "setStatus", statusKey: key, statusText: text } as RpcExtensionUIRequest);
		},
		setWorkingMessage(_message?: string): void {},
		setWorkingVisible(_visible: boolean): void {},
		setWorkingIndicator(_options?: WorkingIndicatorOptions): void {},
		setHiddenThinkingLabel(_label?: string): void {},
		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
			if (content === undefined || Array.isArray(content)) {
				broadcast({ type: "extension_ui_request", id: crypto.randomUUID(), method: "setWidget", widgetKey: key, widgetLines: content as string[] | undefined, widgetPlacement: options?.placement } as RpcExtensionUIRequest);
			}
		},
		setFooter(_factory: unknown): void {},
		setHeader(_factory: unknown): void {},
		setSidebar(_factory: unknown, _options?: unknown): void {},
		setTitle(title: string): void {
			broadcast({ type: "extension_ui_request", id: crypto.randomUUID(), method: "setTitle", title } as RpcExtensionUIRequest);
		},
		async custom() { return undefined as never; },
		pasteToEditor(text: string): void { this.setEditorText(text); },
		setEditorText(text: string): void {
			broadcast({ type: "extension_ui_request", id: crypto.randomUUID(), method: "set_editor_text", text } as RpcExtensionUIRequest);
		},
		getEditorText(): string { return ""; },
		async editor(title: string, prefill?: string): Promise<string | undefined> {
			const id = crypto.randomUUID();
			return new Promise((resolve, reject) => {
				pendingExtensionRequests.set(id, {
					resolve: (response: RpcExtensionUIResponse) => {
						if ("cancelled" in response && response.cancelled) resolve(undefined);
						else if ("value" in response) resolve(response.value);
						else resolve(undefined);
					},
					reject,
				});
				broadcast({ type: "extension_ui_request", id, method: "editor", title, prefill } as RpcExtensionUIRequest);
			});
		},
		addAutocompleteProvider(): void {},
		setEditorComponent(): void {},
		getEditorComponent() { return undefined; },
		get theme() { return theme; },
		getAllThemes() { return []; },
		getTheme(_name: string) { return undefined; },
		setTheme(_theme: string | Theme) { return { success: false, error: "Theme switching not supported in web mode" }; },
		getToolsExpanded() { return false; },
		setToolsExpanded(_expanded: boolean) {},
	});

	// Rebind session (same pattern as RPC mode)
	let unsubscribe: (() => void) | undefined;

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		await session.bindExtensions({
			uiContext: createExtensionUIContext(),
			commandContextActions: {
				waitForIdle: () => session.agent.waitForIdle(),
				newSession: async (opts) => runtimeHost.newSession(opts),
				fork: async (entryId, forkOptions) => {
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, opts) => {
					const result = await session.navigateTree(targetId, {
						summarize: opts?.summarize,
						customInstructions: opts?.customInstructions,
						replaceInstructions: opts?.replaceInstructions,
						label: opts?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, opts) => runtimeHost.switchSession(sessionPath, opts),
				reload: async () => { await session.reload(); },
			},
			shutdownHandler: () => { /* shutdown handled by signal handlers */ },
			onError: (err) => {
				// Suppress stale context errors (e.g. sidebar timer after session switch)
				if (typeof err.error === "string" && err.error.includes("stale")) return;
				broadcast({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
			},
		});

		unsubscribe?.();
		unsubscribe = session.subscribe((event) => {
			console.log(`[Web] Session event: ${event.type}`);
			broadcast(event);
		});
	};

	await rebindSession();

	// Handle a single RPC command
	const handleCommand = async (command: RpcCommand): Promise<RpcResponse | undefined> => {
		const id = command.id;
		switch (command.type) {
			case "prompt": {
				let preflightSucceeded = false;
				void session
					.prompt(command.message, {
						images: command.images,
						streamingBehavior: command.streamingBehavior,
						source: "web",
						preflightResult: (didSucceed) => {
							if (didSucceed) {
								preflightSucceeded = true;
								broadcast(success(id, "prompt"));
							}
						},
					})
					.catch((e) => {
						if (!preflightSucceeded) {
							broadcast(error(id, "prompt", e.message));
						}
					});
				return undefined;
			}
			case "steer": {
				await session.steer(command.message, command.images);
				return success(id, "steer");
			}
			case "follow_up": {
				await session.followUp(command.message, command.images);
				return success(id, "follow_up");
			}
			case "abort": {
				await session.abort();
				return success(id, "abort");
			}
			case "new_session": {
				const opts = command.parentSession ? { parentSession: command.parentSession } : undefined;
				const result = await runtimeHost.newSession(opts);
				if (!result.cancelled) await rebindSession();
				return success(id, "new_session", result);
			}
			case "get_state": {
				const state: RpcSessionState = {
					model: session.model,
					thinkingLevel: session.thinkingLevel,
					isStreaming: session.isStreaming,
					isCompacting: session.isCompacting,
					steeringMode: session.steeringMode,
					followUpMode: session.followUpMode,
					sessionFile: session.sessionFile,
					sessionId: session.sessionId,
					sessionName: session.sessionName,
					autoCompactionEnabled: session.autoCompactionEnabled,
					messageCount: session.messages.length,
					pendingMessageCount: session.pendingMessageCount,
				};
				return success(id, "get_state", state);
			}
			case "set_model": {
				const models = session.modelRegistry.getAvailable();
				const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
				if (!model) return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				await session.setModel(model);
				return success(id, "set_model", model);
			}
			case "cycle_model": {
				const result = await session.cycleModel();
				return success(id, "cycle_model", result ?? null);
			}
			case "get_available_models": {
				const models = session.modelRegistry.getAvailable();
				return success(id, "get_available_models", { models });
			}
			case "set_thinking_level": {
				session.setThinkingLevel(command.level);
				return success(id, "set_thinking_level");
			}
			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				return success(id, "cycle_thinking_level", level ? { level } : null);
			}
			case "set_steering_mode": {
				session.setSteeringMode(command.mode);
				return success(id, "set_steering_mode");
			}
			case "set_follow_up_mode": {
				session.setFollowUpMode(command.mode);
				return success(id, "set_follow_up_mode");
			}
			case "compact": {
				const result = await session.compact(command.customInstructions);
				return success(id, "compact", result);
			}
			case "set_auto_compaction": {
				session.setAutoCompactionEnabled(command.enabled);
				return success(id, "set_auto_compaction");
			}
			case "set_auto_retry": {
				session.setAutoRetryEnabled(command.enabled);
				return success(id, "set_auto_retry");
			}
			case "abort_retry": {
				session.abortRetry();
				return success(id, "abort_retry");
			}
			case "bash": {
				const result = await session.executeBash(command.command, undefined, {
					excludeFromContext: command.excludeFromContext,
				});
				return success(id, "bash", result);
			}
			case "abort_bash": {
				session.abortBash();
				return success(id, "abort_bash");
			}
			case "get_session_stats": {
				const stats = session.getSessionStats();
				return success(id, "get_session_stats", stats);
			}
			case "export_html": {
				const outputPath = await session.exportToHtml(command.outputPath);
				return success(id, "export_html", { path: outputPath });
			}
			case "switch_session": {
				console.log(`[Web] Switching session to: ${command.sessionPath}`);
				const result = await runtimeHost.switchSession(command.sessionPath);
				console.log(`[Web] Switch result: cancelled=${result.cancelled}`);
				if (!result.cancelled) {
					await rebindSession();
					console.log(`[Web] Session rebound, messages: ${session.messages.length}`);
				}
				return success(id, "switch_session", result);
			}
			case "fork": {
				const result = await runtimeHost.fork(command.entryId);
				if (!result.cancelled) await rebindSession();
				return success(id, "fork", { text: result.selectedText, cancelled: result.cancelled });
			}
			case "clone": {
				const leafId = session.sessionManager.getLeafId();
				if (!leafId) return error(id, "clone", "Cannot clone session: no current entry selected");
				const result = await runtimeHost.fork(leafId, { position: "at" });
				if (!result.cancelled) await rebindSession();
				return success(id, "clone", { cancelled: result.cancelled });
			}
			case "get_fork_messages": {
				const messages = session.getUserMessagesForForking();
				return success(id, "get_fork_messages", { messages });
			}
			case "get_last_assistant_text": {
				const text = session.getLastAssistantText();
				return success(id, "get_last_assistant_text", { text });
			}
			case "set_session_name": {
				const name = command.name.trim();
				if (!name) return error(id, "set_session_name", "Session name cannot be empty");
				session.setSessionName(name);
				return success(id, "set_session_name");
			}
			case "get_messages": {
				return success(id, "get_messages", { messages: session.messages });
			}
			case "get_commands": {
				const commands: RpcSlashCommand[] = [];
				for (const cmd of session.extensionRunner.getRegisteredCommands()) {
					commands.push({ name: cmd.invocationName, description: cmd.description, source: "extension", sourceInfo: cmd.sourceInfo });
				}
				for (const template of session.promptTemplates) {
					commands.push({ name: template.name, description: template.description, source: "prompt", sourceInfo: template.sourceInfo });
				}
				for (const skill of session.resourceLoader.getSkills().skills) {
					commands.push({ name: `skill:${skill.name}`, description: skill.description, source: "skill", sourceInfo: skill.sourceInfo });
				}
				return success(id, "get_commands", { commands });
			}
			default: {
				const unknownCommand = command as { type: string };
				return error(undefined, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	};

	// Read index.html
	const indexPath = path.join(__dirname, "static", "index.html");
	let indexHtml: string;
	try {
		indexHtml = fs.readFileSync(indexPath, "utf-8");
	} catch {
		indexHtml = "<html><body><h1>Error: index.html not found</h1></body></html>";
	}

	// HTTP server
	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

		// Serve index.html for root
		if (url.pathname === "/" || url.pathname === "/index.html") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(indexHtml);
			return;
		}

		// REST API: GET /api/state
		if (url.pathname === "/api/state" && req.method === "GET") {
			const state: RpcSessionState = {
				model: session.model,
				thinkingLevel: session.thinkingLevel,
				isStreaming: session.isStreaming,
				isCompacting: session.isCompacting,
				steeringMode: session.steeringMode,
				followUpMode: session.followUpMode,
				sessionFile: session.sessionFile,
				sessionId: session.sessionId,
				sessionName: session.sessionName,
				autoCompactionEnabled: session.autoCompactionEnabled,
				messageCount: session.messages.length,
				pendingMessageCount: session.pendingMessageCount,
			};
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(state));
			return;
		}

		// REST API: GET /api/messages
		if (url.pathname === "/api/messages" && req.method === "GET") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ messages: session.messages }));
			return;
		}

		// REST API: GET /api/models
		if (url.pathname === "/api/models" && req.method === "GET") {
			try {
				const models = session.modelRegistry.getAvailable();
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ models }));
			} catch (err: unknown) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
			}
			return;
		}

		// REST API: GET /api/sessions
		if (url.pathname === "/api/sessions" && req.method === "GET") {
			try {
				const sessions = await SessionManager.listAll();
				const current = session.sessionFile;
				console.log(`[Web] Sessions API: current="${current}"`);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({
					sessions: sessions.map((s) => ({
						id: s.id,
						name: s.name || null,
						cwd: s.cwd,
						modified: s.modified.toISOString(),
						messageCount: s.messageCount,
						firstMessage: s.firstMessage,
						file: s.path,
						isCurrent: current ? s.path === current || s.path.replace(/\\/g, "/") === current?.replace(/\\/g, "/") : false,
					})),
				}));
			} catch (err: unknown) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
			}
			return;
		}

		// REST API: POST /api/register — agent self-registration
		if (url.pathname === "/api/register" && req.method === "POST") {
			let body = "";
			req.on("data", (chunk) => { body += chunk; });
			req.on("end", () => {
				try {
					const data = JSON.parse(body);
					const agent = { host: data.host, name: data.name || data.host, cwd: data.cwd || "", port: data.port };
					if (!agent.host) {
						res.writeHead(400, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: "Missing host" }));
						return;
					}
					// Add to known agents if not already present
					if (!knownAgents.find((a) => a.host === agent.host)) {
						knownAgents.push(agent);
						console.log(`[Web] Agent registered: ${agent.name} (${agent.host})`);
						// Broadcast to all connected dashboard clients
						broadcast({ type: "agent_registered", agent });
					}
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ ok: true }));
				} catch {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "Invalid JSON" }));
				}
			});
			return;
		}

		// REST API: GET /api/agents — list registered agents
		if (url.pathname === "/api/agents" && req.method === "GET") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ agents: knownAgents }));
			return;
		}

		// REST API: GET /api/files?path=
		if (url.pathname === "/api/files" && req.method === "GET") {
			try {
				const reqPath = url.searchParams.get("path") || process.cwd();
				const resolved = path.resolve(reqPath);
				const stat = await fsp.stat(resolved);
				if (!stat.isDirectory()) {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "Not a directory" }));
					return;
				}
				const entries = await fsp.readdir(resolved, { withFileTypes: true });
				const items = entries
					.filter((e) => !e.name.startsWith("."))
					.sort((a, b) => {
						if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
						return a.name.localeCompare(b.name);
					})
					.map((e) => ({
						name: e.name,
						isDirectory: e.isDirectory(),
						path: path.join(resolved, e.name),
					}));
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ path: resolved, items }));
			} catch (err: unknown) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
			}
			return;
		}

		// REST API: GET /api/file?path=
		if (url.pathname === "/api/file" && req.method === "GET") {
			try {
				const reqPath = url.searchParams.get("path");
				if (!reqPath) {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "Missing path parameter" }));
					return;
				}
				const resolved = path.resolve(reqPath);
				const stat = await fsp.stat(resolved);
				if (stat.isDirectory()) {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "Is a directory" }));
					return;
				}
				// Limit file size to 1MB
				if (stat.size > 1024 * 1024) {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "File too large (max 1MB)" }));
					return;
				}
				const content = await fsp.readFile(resolved, "utf-8");
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ path: resolved, content, size: stat.size }));
			} catch (err: unknown) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
			}
			return;
		}

		// REST API: GET /api/skills
		if (url.pathname === "/api/skills" && req.method === "GET") {
			try {
				const skills = session.resourceLoader.getSkills().skills;
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({
					skills: skills.map((s) => ({
						name: s.name,
						description: s.description,
						sourceInfo: s.sourceInfo,
					})),
				}));
			} catch (err: unknown) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
			}
			return;
		}

		// REST API: GET /api/commands
		if (url.pathname === "/api/commands" && req.method === "GET") {
			try {
				const commands: Array<{ name: string; description?: string; source: string }> = [];

				for (const cmd of session.extensionRunner.getRegisteredCommands()) {
					commands.push({ name: cmd.invocationName, description: cmd.description, source: "extension" });
				}
				for (const template of session.promptTemplates) {
					commands.push({ name: template.name, description: template.description, source: "prompt" });
				}
				for (const skill of session.resourceLoader.getSkills().skills) {
					commands.push({ name: `skill:${skill.name}`, description: skill.description, source: "skill" });
				}

				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ commands }));
			} catch (err: unknown) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
			}
			return;
		}

		// REST API: GET /api/extensions
		if (url.pathname === "/api/extensions" && req.method === "GET") {
			try {
				const commands = session.extensionRunner.getRegisteredCommands();
				// Deduplicate by source path
				const seen = new Set<string>();
				const extensions = commands
					.filter((c) => c.sourceInfo?.path && !seen.has(c.sourceInfo.path) && seen.add(c.sourceInfo.path))
					.map((c) => ({
						name: c.invocationName,
						description: c.description,
						path: c.sourceInfo?.path,
					}));
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ extensions }));
			} catch (err: unknown) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
			}
			return;
		}

		// 404
		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "Not found" }));
	});

	// WebSocket server
	const wss = new WebSocketServer({ server, path: "/ws" });

	wss.on("connection", (ws, req) => {
		clients.add(ws);
		console.log(`[Web] Client connected from ${req.socket.remoteAddress} (total: ${clients.size})`);

		// Send current state on connect
		const state: RpcSessionState & { cwd: string } = {
			model: session.model,
			thinkingLevel: session.thinkingLevel,
			isStreaming: session.isStreaming,
			isCompacting: session.isCompacting,
			steeringMode: session.steeringMode,
			followUpMode: session.followUpMode,
			sessionFile: session.sessionFile,
			sessionId: session.sessionId,
			sessionName: session.sessionName,
			autoCompactionEnabled: session.autoCompactionEnabled,
			messageCount: session.messages.length,
			pendingMessageCount: session.pendingMessageCount,
			cwd: process.cwd(),
		};
		ws.send(JSON.stringify({ type: "connected", state } as object));

		ws.on("message", async (data) => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(data.toString());
			} catch (parseError) {
				ws.send(JSON.stringify(error(undefined, "parse", `Failed to parse command: ${parseError instanceof Error ? parseError.message : String(parseError)}`)));
				return;
			}

			// Handle extension UI responses
			if (typeof parsed === "object" && parsed !== null && "type" in parsed && parsed.type === "extension_ui_response") {
				const response = parsed as RpcExtensionUIResponse;
				const pending = pendingExtensionRequests.get(response.id);
				if (pending) {
					pendingExtensionRequests.delete(response.id);
					pending.resolve(response);
				}
				return;
			}

			const command = parsed as RpcCommand;
			try {
				const response = await handleCommand(command);
				if (response) {
					ws.send(JSON.stringify(response));
				}
			} catch (commandError) {
				ws.send(JSON.stringify(error(command.id, command.type, commandError instanceof Error ? commandError.message : String(commandError))));
			}
		});

		ws.on("close", () => {
			clients.delete(ws);
		});
	});

	// Suppress stale extension context errors from crashing the process
	// These come from extension timers (e.g. sidebar refresh) that fire after session replacement
	process.on("uncaughtException", (err) => {
		if (err.message?.includes("stale")) return;
		console.error("[Web] Uncaught exception:", err);
	});

	// Start server
	return new Promise<never>((resolve, reject) => {
		server.listen(port, "127.0.0.1", async () => {
			console.log(`\n  Pi Agent Web UI running at:\n`);
			console.log(`  http://localhost:${port}\n`);
			console.log(`  Press Ctrl+C to stop.\n`);

			// Register with dashboard if specified
			if (options.register) {
				await registerWithDashboard(options.register);
			}

			// Handle shutdown
			const shutdown = async () => {
				unsubscribe?.();
				for (const ws of clients) ws.close();
				wss.close();
				server.close();
				await runtimeHost.dispose();
				killTrackedDetachedChildren();
				process.exit(0);
			};

			process.on("SIGINT", () => void shutdown());
			process.on("SIGTERM", () => void shutdown());
		});

		server.on("error", (err) => {
			console.error(`Failed to start web server: ${err.message}`);
			reject(err);
		});
	});
}
