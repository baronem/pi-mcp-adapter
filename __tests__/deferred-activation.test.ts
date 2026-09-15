import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activate: vi.fn(),
}));

vi.mock("../runtime.ts", () => ({
  activateMcpRuntime: mocks.activate,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createPi() {
  const commands = new Map<string, any>();
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  const eventHandlers = new Map<string, Array<(request: any) => void>>();
  const api = {
    registerFlag: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
    on: vi.fn((name: string, handler: (...args: any[]) => unknown) => {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    }),
    events: {
      on: vi.fn((name: string, handler: (request: any) => void) => {
        const list = eventHandlers.get(name) ?? [];
        list.push(handler);
        eventHandlers.set(name, list);
      }),
      emit: vi.fn((name: string, request: any) => {
        for (const handler of eventHandlers.get(name) ?? []) handler(request);
      }),
    },
  } as any;
  return { api, commands, handlers };
}

function createContext() {
  return {
    hasUI: true,
    cwd: "/tmp/project",
    mode: "tui",
    ui: { setStatus: vi.fn(), notify: vi.fn() },
  } as any;
}

describe("deferred MCP bootstrap", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.activate.mockReset();
  });

  it("registers only the bootstrap command and CLI flag before activation", async () => {
    const { default: adapter } = await import("../index.ts");
    const { api, commands } = createPi();
    adapter(api);

    expect(api.registerFlag).toHaveBeenCalledWith("mcp-config", expect.any(Object));
    expect([...commands.keys()]).toEqual(["mcp-enable"]);
    expect(api.registerTool).not.toHaveBeenCalled();
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it("loads once, then exposes and delegates the MCP command", async () => {
    const handleMcpCommand = vi.fn().mockResolvedValue(undefined);
    const getMcpArgumentCompletions = vi.fn().mockReturnValue(null);
    mocks.activate.mockResolvedValue({ handleMcpCommand, getMcpArgumentCompletions });
    const { default: adapter } = await import("../index.ts");
    const { api, commands } = createPi();
    const ctx = createContext();
    adapter(api);

    expect(commands.has("mcp")).toBe(false);
    await commands.get("mcp-enable").handler("ignored", ctx);
    expect(commands.has("mcp")).toBe(true);
    await commands.get("mcp").handler("status", ctx);

    expect(mocks.activate).toHaveBeenCalledTimes(1);
    expect(mocks.activate).toHaveBeenCalledWith(api, ctx, {});
    expect(handleMcpCommand).toHaveBeenCalledOnce();
    expect(handleMcpCommand).toHaveBeenCalledWith("status", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("MCP enabled", "info");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("mcp", "MCP: loading...");
    expect(ctx.ui.setStatus).not.toHaveBeenCalledWith("mcp", undefined);
  });

  it("coalesces concurrent activation requests", async () => {
    const pending = deferred<any>();
    const handleMcpCommand = vi.fn().mockResolvedValue(undefined);
    mocks.activate.mockReturnValue(pending.promise);
    const { default: adapter } = await import("../index.ts");
    const { api, commands } = createPi();
    const ctx = createContext();
    adapter(api);

    const first = commands.get("mcp-enable").handler("", ctx);
    const second = commands.get("mcp-enable").handler("", ctx);
    await vi.waitFor(() => expect(mocks.activate).toHaveBeenCalledTimes(1));
    pending.resolve({ handleMcpCommand });
    await Promise.all([first, second]);

    expect(handleMcpCommand).not.toHaveBeenCalled();
    expect(commands.has("mcp")).toBe(true);
  });

  it("clears loading status and prevents duplicate installation after activation fails", async () => {
    // A mocked activation rejection represents a partially installed runtime,
    // which is intentionally terminal until reload.
    mocks.activate.mockRejectedValueOnce(new Error("install failed"));
    const { default: adapter } = await import("../index.ts");
    const { api, commands } = createPi();
    const ctx = createContext();
    adapter(api);

    await commands.get("mcp-enable").handler("", ctx);
    await commands.get("mcp-enable").handler("", ctx);

    expect(mocks.activate).toHaveBeenCalledTimes(1);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("mcp", undefined);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("install failed"), "error");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("reload Pi"), "error");
  });

  it("reports installed-but-inactive runtime registration without activating", async () => {
    const { default: adapter, getRuntimeMcpServerSnapshot, registerMcpServer } = await import("../index.ts");
    const { api } = createPi();
    adapter(api);

    expect(() => registerMcpServer({ pi: api, name: "demo", definition: { url: "https://example.test/mcp" } }))
      .toThrow("Run /mcp-enable first");
    expect(() => getRuntimeMcpServerSnapshot({ pi: api, name: "demo" })).toThrow("Run /mcp-enable first");
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it("clears bootstrap status when shutdown races activation", async () => {
    const pending = deferred<any>();
    mocks.activate.mockReturnValue(pending.promise);
    const { default: adapter } = await import("../index.ts");
    const { api, commands, handlers } = createPi();
    const ctx = createContext();
    adapter(api);

    const activation = commands.get("mcp-enable").handler("", ctx);
    await vi.waitFor(() => expect(mocks.activate).toHaveBeenCalled());
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
    pending.resolve({ handleMcpCommand: vi.fn() });
    await activation;

    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("mcp", undefined);
  });
});
