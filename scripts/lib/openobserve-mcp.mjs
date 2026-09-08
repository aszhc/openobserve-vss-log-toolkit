import fs from "node:fs";
import path from "node:path";

function expandEnvironment(value) {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_match, name) => {
    const resolved = process.env[name];
    if (!resolved) throw new Error(`Missing required environment variable: ${name}`);
    return resolved;
  });
}

function sanitizeMessage(message, server) {
  let safe = String(message);
  for (const value of Object.values(server?.headers ?? {})) {
    if (typeof value === "string" && value) safe = safe.split(value).join("<redacted>");
  }
  return safe;
}

export function findProjectMcpConfig(startDir = process.cwd(), explicitPath) {
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    if (!fs.existsSync(resolved)) throw new Error(`MCP config not found: ${resolved}`);
    return resolved;
  }

  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, ".mcp.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`No .mcp.json found from ${path.resolve(startDir)}`);
}

export function loadMcpServer({ configPath, serverName = "openobserve" }) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read MCP config: ${error.message}`);
  }
  const entry = config?.mcpServers?.[serverName] ?? config?.mcp_servers?.[serverName];
  if (!entry || typeof entry !== "object") {
    throw new Error(`MCP server not found in config: ${serverName}`);
  }
  const url = expandEnvironment(entry.url);
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) {
    throw new Error(`MCP server has an invalid HTTP URL: ${serverName}`);
  }
  const headers = Object.fromEntries(
    Object.entries(entry.headers ?? entry.http_headers ?? {}).map(([key, value]) => [
      key,
      expandEnvironment(value),
    ]),
  );
  return { url, headers };
}

export function parseMcpResponse(text) {
  try {
    return JSON.parse(text);
  } catch {
    const data = String(text)
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter((line) => line && line !== "[DONE]");
    for (let index = data.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(data[index]);
      } catch {
        // Keep looking for the last valid JSON event.
      }
    }
  }
  throw new Error("MCP returned neither JSON nor a valid SSE data event");
}

export function extractHits(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value.hits)) return value.hits;
  if (Array.isArray(value.structuredContent?.hits)) return value.structuredContent.hits;
  if (value.result) {
    const resultHits = extractHits(value.result);
    if (resultHits) return resultHits;
  }
  for (const item of value.content ?? []) {
    if (item?.type !== "text" || typeof item.text !== "string") continue;
    try {
      const hits = extractHits(JSON.parse(item.text));
      if (hits) return hits;
    } catch {
      // Ignore non-JSON presentation blocks.
    }
  }
  return null;
}

function findSearchMetadata(value) {
  if (!value || typeof value !== "object") return {};
  if (value.structuredContent && typeof value.structuredContent === "object") {
    return value.structuredContent;
  }
  if (value.result) return findSearchMetadata(value.result);
  for (const item of value.content ?? []) {
    if (item?.type !== "text" || typeof item.text !== "string") continue;
    try {
      const metadata = findSearchMetadata(JSON.parse(item.text));
      if (Object.keys(metadata).length) return metadata;
    } catch {
      // Ignore non-JSON presentation blocks.
    }
  }
  return value;
}

export async function searchSql({
  server,
  orgId,
  sql,
  startUs,
  endUs,
  from = 0,
  size = 1000,
  fetchImpl = fetch,
}) {
  if (!Number.isSafeInteger(startUs) || startUs <= 0) throw new Error("startUs must be a positive safe integer");
  if (!Number.isSafeInteger(endUs) || endUs <= startUs) throw new Error("endUs must be greater than startUs");
  if (!Number.isInteger(from) || from < 0) throw new Error("from must be a non-negative integer");
  if (!Number.isInteger(size) || size <= 0) throw new Error("size must be a positive integer");

  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "tools_call",
      arguments: {
        tool: "SearchSQL",
        args: {
          org_id: orgId,
          type: "logs",
          request_body: {
            query: {
              sql,
              start_time: startUs,
              end_time: endUs,
              from,
              size,
            },
          },
        },
        detail: "full",
      },
    },
  };

  let httpResponse;
  try {
    httpResponse = await fetchImpl(server.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(server.headers ?? {}) },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw new Error(`OpenObserve MCP connection failed: ${sanitizeMessage(error.message, server)}`);
  }
  if (!httpResponse.ok) throw new Error(`OpenObserve MCP returned HTTP ${httpResponse.status}`);

  const envelope = parseMcpResponse(await httpResponse.text());
  if (envelope.error) {
    throw new Error(`OpenObserve MCP error: ${sanitizeMessage(envelope.error.message ?? envelope.error.code, server)}`);
  }
  const metadata = findSearchMetadata(envelope.result ?? envelope);
  return {
    hits: extractHits(envelope.result ?? envelope) ?? [],
    total: metadata.total,
    scanRecords: metadata.scan_records ?? metadata.scanRecords,
    took: metadata.took,
  };
}

export async function searchAllSql({ pageSize = 1000, ...options }) {
  const hits = [];
  let requests = 0;
  let scanRecords = 0;
  let took = 0;
  for (let from = 0; ; from += pageSize) {
    const page = await searchSql({ ...options, from, size: pageSize });
    requests += 1;
    hits.push(...page.hits);
    if (Number.isFinite(page.scanRecords)) scanRecords += Number(page.scanRecords);
    if (Number.isFinite(page.took)) took += Number(page.took);
    if (page.hits.length < pageSize) break;
  }
  return { hits, requests, scanRecords, took };
}
