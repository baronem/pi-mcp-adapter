import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { resourceNameToToolName } from "./resource-tools.ts";
import { isUiToolVisibleToModel } from "./ui-tool-visibility.ts";
import {
  createToolSelectorCandidateIndex,
  getToolNameCandidates,
  isServerDisabled,
  resolveToolPrefix,
  type MetadataCache,
  type ServerCacheEntry,
  type ServerEntry,
  type ToolPrefix,
  type ToolSelectorCandidateIndex,
} from "./types.ts";

const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function interpolate(value: string, environment: NodeJS.ProcessEnv): string {
  return value
    .replace(/\$\{(\w+)\}/g, (_, name) => environment[name] ?? "")
    .replace(/\$env:(\w+)/g, (_, name) => environment[name] ?? "")
    .replace(/\{env:(\w+)\}/g, (_, name) => environment[name] ?? "");
}

function interpolateSecret(value: string, environment: NodeJS.ProcessEnv): string {
  if (value.startsWith("!!")) return interpolate(value.slice(1), environment);
  return value.startsWith("!") ? value : interpolate(value, environment);
}

function interpolateRecord(values: Record<string, string> | undefined, environment: NodeJS.ProcessEnv) {
  return values && Object.fromEntries(Object.entries(values).map(([key, value]) => [key, interpolateSecret(value, environment)]));
}

function resolvePath(value: string | undefined, environment: NodeJS.ProcessEnv): string | undefined {
  if (value === undefined) return undefined;
  const resolved = interpolate(value, environment);
  if (resolved === "~") return homedir();
  if (resolved.startsWith("~/") || resolved.startsWith("~\\")) return join(homedir(), resolved.slice(2));
  return resolved;
}

function resolveUrl(value: string | undefined, environment: NodeJS.ProcessEnv): string | undefined {
  if (value === undefined) return undefined;
  const missing = [...value.matchAll(/\$\{(\w+)\}|\$env:(\w+)|\{env:(\w+)\}/g)]
    .map(match => match[1] ?? match[2] ?? match[3])
    .filter((name): name is string => !!name && environment[name] === undefined);
  if (missing.length > 0) throw new Error(`Missing environment variables in MCP server URL: ${missing.join(", ")}`);
  const resolved = interpolate(value, environment);
  new URL(resolved);
  return resolved;
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(",")}}`;
}

function computeServerHash(definition: ServerEntry, environment: NodeJS.ProcessEnv): string {
  const identity: Record<string, unknown> = {
    command: definition.command,
    args: definition.args,
    socket: resolvePath(definition.socket, environment),
    env: interpolateRecord(definition.env, environment),
    cwd: resolvePath(definition.cwd, environment),
    url: resolveUrl(definition.url, environment),
    headers: interpolateRecord(definition.headers, environment),
    requestHeadersCommand: definition.requestHeadersCommand ? {
      command: interpolate(definition.requestHeadersCommand.command, environment),
      args: definition.requestHeadersCommand.args?.map(argument => interpolate(argument, environment)),
      env: interpolateRecord(definition.requestHeadersCommand.env, environment),
      timeoutMs: definition.requestHeadersCommand.timeoutMs,
    } : undefined,
    auth: definition.auth,
    protocolVersion: definition.protocolVersion,
    bearerToken: definition.bearerToken !== undefined
      ? interpolateSecret(definition.bearerToken, environment)
      : definition.bearerTokenEnv ? environment[definition.bearerTokenEnv] : undefined,
    bearerTokenEnv: definition.bearerTokenEnv,
    exposeResources: definition.exposeResources,
    includeTools: definition.includeTools,
    excludeTools: definition.excludeTools,
  };
  return createHash("sha256").update(stableStringify(identity)).digest("hex");
}

export function isServerCacheValid(entry: ServerCacheEntry, definition: ServerEntry, maxAgeMs = CACHE_MAX_AGE_MS, environment = process.env): boolean {
  let configHash: string;
  try { configHash = computeServerHash(definition, environment); } catch { return false; }
  if (!entry || entry.configHash !== configHash || !entry.cachedAt || typeof entry.cachedAt !== "number") return false;
  if (typeof entry.ttlMs === "number" && Number.isSafeInteger(entry.ttlMs) && entry.ttlMs >= 0) {
    if (entry.ttlMs === 0) return false;
    const effectiveMaxAge = maxAgeMs > 0 ? Math.min(maxAgeMs, entry.ttlMs) : entry.ttlMs;
    return Date.now() - entry.cachedAt < effectiveMaxAge;
  }
  return maxAgeMs <= 0 || Date.now() - entry.cachedAt <= maxAgeMs;
}

export function parseDirectToolSelectors(selectors: string[]): { servers: Set<string>; tools: Map<string, Set<string>> } {
  const servers = new Set<string>();
  const tools = new Map<string, Set<string>>();
  for (let selector of selectors) {
    selector = selector.replace(/\/+$/, "");
    if (!selector.includes("/")) { if (selector) servers.add(selector); continue; }
    const [server, tool] = selector.split("/", 2);
    if (server && tool) {
      const selected = tools.get(server) ?? new Set<string>();
      selected.add(tool);
      tools.set(server, selected);
    } else if (server) servers.add(server);
  }
  return { servers, tools };
}

export function createCachedToolSelectorCandidateIndex(configuredServers: Record<string, ServerEntry>, cache: MetadataCache, prefix: ToolPrefix): ToolSelectorCandidateIndex {
  const candidates = new Set<string>();
  for (const [serverName, definition] of Object.entries(configuredServers)) {
    const entry = cache.servers[serverName];
    if (!entry || !isServerCacheValid(entry, definition) || isServerDisabled(definition)) continue;
    const effectivePrefix = resolveToolPrefix(definition, prefix);
    for (const tool of entry.tools ?? []) {
      if (!isUiToolVisibleToModel(tool.uiVisibility)) continue;
      for (const candidate of getToolNameCandidates(tool.name, serverName, effectivePrefix, false)) candidates.add(candidate);
    }
    if (definition.exposeResources !== false) {
      for (const resource of entry.resources ?? []) {
        const baseName = `read_${resourceNameToToolName(resource.name)}`;
        for (const candidate of getToolNameCandidates(baseName, serverName, effectivePrefix, false)) candidates.add(candidate);
      }
    }
  }
  return createToolSelectorCandidateIndex(candidates);
}
