import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { McpAdapterOptions, ServerEntry } from "./types.ts";
import {
  MCP_RUNTIME_REGISTER_EVENT,
  MCP_RUNTIME_REGISTER_VERSION,
  MCP_RUNTIME_SNAPSHOT_EVENT,
  MCP_RUNTIME_SNAPSHOT_VERSION,
  type ActivatedMcpRuntime,
  type McpRuntimeRegistrationRequest,
  type McpRuntimeServerSnapshot,
  type McpRuntimeSnapshotRequest,
  type McpServerRegistration,
} from "./runtime-contract.ts";

export type { McpAdapterOptions, ServerEntry } from "./types.ts";
export {
  namespaceProxyName,
  parseMcpReference,
  resolveMcpToolReferences,
  type McpReferenceResolution,
  type ParsedMcpReference,
} from "./mcp-references.ts";
export {
  MCP_STATUS_EVENT,
  MCP_STATUS_SNAPSHOT_VERSION,
  MCP_TOOL_APPROVAL_REQUEST_EVENT,
  type McpServerRuntimeStatus,
  type McpServerStatusSnapshot,
  type McpStatusSnapshot,
  type McpToolApprovalDecision,
  type McpToolApprovalHandler,
  type McpToolApprovalOrigin,
  type McpToolApprovalRequest,
} from "./types.ts";
export {
  MCP_RUNTIME_REGISTER_EVENT,
  MCP_RUNTIME_REGISTER_VERSION,
  MCP_RUNTIME_SNAPSHOT_EVENT,
  MCP_RUNTIME_SNAPSHOT_VERSION,
  type McpRuntimeRegistrationRequest,
  type McpRuntimeRegistrationResult,
  type McpRuntimeServerSnapshot,
  type McpRuntimeSnapshotRequest,
  type McpRuntimeSnapshotResult,
  type McpServerRegistration,
} from "./runtime-contract.ts";

type BootstrapPhase = "inactive" | "activating" | "active" | "failed" | "shutdown";

const INACTIVE_MESSAGE = "pi-mcp-adapter is installed but has not been activated. Run /mcp-enable first.";
const FAILED_MESSAGE = "pi-mcp-adapter activation failed after runtime installation; reload Pi before retrying.";

function cloneOptions(options: McpAdapterOptions): McpAdapterOptions {
  return {
    ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
    ...(options.config !== undefined ? { config: structuredClone(options.config) } : {}),
  };
}

export function createMcpAdapter(options: McpAdapterOptions = {}) {
  const savedOptions = cloneOptions(options);

  return function mcpAdapterBootstrap(pi: ExtensionAPI) {
    let phase: BootstrapPhase = "inactive";
    let controller: ActivatedMcpRuntime | undefined;
    let activationPromise: Promise<ActivatedMcpRuntime> | undefined;
    let lifecycleGeneration = 0;

    pi.registerFlag("mcp-config", {
      description: "Path to MCP config file",
      type: "string",
    });

    // Let cross-extension callers distinguish an installed-but-inactive adapter
    // from an adapter that is not installed at all. Once active, the runtime's
    // listener runs later and owns these requests.
    pi.events.on(MCP_RUNTIME_REGISTER_EVENT, (rawRequest: unknown) => {
      if (phase === "active") return;
      if (typeof rawRequest !== "object" || rawRequest === null || Array.isArray(rawRequest)) return;
      const request = rawRequest as McpRuntimeRegistrationRequest;
      if (request.result !== undefined) return;
      if (request.version !== MCP_RUNTIME_REGISTER_VERSION) {
        request.result = { ok: false, error: new Error(`Unsupported MCP runtime registration version: ${String(request.version)}`) };
        return;
      }
      request.result = { ok: false, error: new Error(phase === "failed" ? FAILED_MESSAGE : INACTIVE_MESSAGE) };
    });

    pi.events.on(MCP_RUNTIME_SNAPSHOT_EVENT, (rawRequest: unknown) => {
      if (phase === "active") return;
      if (typeof rawRequest !== "object" || rawRequest === null || Array.isArray(rawRequest)) return;
      const request = rawRequest as McpRuntimeSnapshotRequest;
      if (request.result !== undefined) return;
      if (request.version !== MCP_RUNTIME_SNAPSHOT_VERSION) {
        request.result = { ok: false, error: new Error(`Unsupported MCP runtime snapshot version: ${String(request.version)}`) };
        return;
      }
      request.result = { ok: false, error: new Error(phase === "failed" ? FAILED_MESSAGE : INACTIVE_MESSAGE) };
    });

    const ensureActivated = async (ctx: ExtensionCommandContext): Promise<ActivatedMcpRuntime> => {
      if (phase === "active" && controller) return controller;
      if (phase === "failed") throw new Error(FAILED_MESSAGE);
      if (phase === "shutdown") throw new Error("MCP activation was cancelled because the session is shutting down");
      if (activationPromise) return activationPromise;

      const generation = lifecycleGeneration;
      phase = "activating";
      ctx.ui.setStatus("mcp", "MCP: loading...");

      let installationStarted = false;
      const activationIsStale = () => (phase as BootstrapPhase) === "shutdown" || generation !== lifecycleGeneration;
      activationPromise = (async () => {
        try {
          // Keep this import literal and inside activation: it is the boundary
          // that prevents the MCP SDK and runtime graph from affecting startup.
          const runtime = await import("./runtime.ts");
          if (activationIsStale()) {
            throw new Error("MCP activation was cancelled because the session is shutting down");
          }
          installationStarted = true;
          const activated = await runtime.activateMcpRuntime(pi, ctx, cloneOptions(savedOptions));
          if (activationIsStale()) {
            throw new Error("MCP activation completed after the session began shutting down");
          }
          controller = activated;
          phase = "active";
          pi.registerCommand("mcp", {
            description: "Manage MCP servers",
            getArgumentCompletions: (prefix) => activated.getMcpArgumentCompletions(prefix),
            handler: (args, commandCtx) => activated.handleMcpCommand(args, commandCtx),
          });
          return activated;
        } catch (error) {
          if ((phase as BootstrapPhase) !== "shutdown") phase = installationStarted ? "failed" : "inactive";
          ctx.ui.setStatus("mcp", undefined);
          throw error;
        } finally {
          activationPromise = undefined;
        }
      })();

      return activationPromise;
    };

    pi.registerCommand("mcp-enable", {
      description: "Load and enable MCP support for this session",
      handler: async (_args, ctx) => {
        const wasActive = phase === "active";
        try {
          await ensureActivated(ctx);
          ctx.ui.notify(wasActive ? "MCP is already enabled" : "MCP enabled", "info");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.setStatus("mcp", undefined);
          ctx.ui.notify(`MCP activation failed: ${message}`, "error");
        }
      },
    });

    pi.on("session_shutdown", (_event, ctx) => {
      lifecycleGeneration += 1;
      phase = "shutdown";
      ctx.ui.setStatus("mcp", undefined);
    });
  };
}

/** Register a session-scoped MCP server after the adapter has been activated. */
export function registerMcpServer(options: { pi: ExtensionAPI; name: string; definition: ServerEntry }): McpServerRegistration {
  const { pi, name, definition } = options;
  const request: McpRuntimeRegistrationRequest = {
    version: MCP_RUNTIME_REGISTER_VERSION,
    name,
    definition,
  };
  pi.events.emit(MCP_RUNTIME_REGISTER_EVENT, request);
  if (!request.result) throw new Error("pi-mcp-adapter is not installed for this Pi instance");
  if (!request.result.ok) throw request.result.error;
  return request.result.registration;
}

/** Return a detached snapshot of a runtime-registered MCP server. */
export function getRuntimeMcpServerSnapshot(options: { pi: ExtensionAPI; name: string }): McpRuntimeServerSnapshot {
  const request: McpRuntimeSnapshotRequest = {
    version: MCP_RUNTIME_SNAPSHOT_VERSION,
    name: options.name,
  };
  options.pi.events.emit(MCP_RUNTIME_SNAPSHOT_EVENT, request);
  if (!request.result) throw new Error("pi-mcp-adapter is not installed for this Pi instance");
  if (!request.result.ok) throw request.result.error;
  return request.result.snapshot;
}

export default createMcpAdapter();
