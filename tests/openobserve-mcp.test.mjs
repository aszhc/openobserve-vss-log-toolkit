import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  extractHits,
  findProjectMcpConfig,
  loadMcpServer,
  parseMcpResponse,
  searchAllSql,
  searchSql,
} from "../scripts/lib/openobserve-mcp.mjs";

function response(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("finds and loads a project MCP configuration", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vss-mcp-config-"));
  const nested = path.join(root, "one", "two");
  fs.mkdirSync(nested, { recursive: true });
  const configPath = path.join(root, ".mcp.json");
  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      openobserve: {
        type: "http",
        url: "http://example.invalid/mcp",
        headers: { Authorization: "Basic top-secret" },
      },
    },
  }));

  assert.equal(findProjectMcpConfig(nested), configPath);
  const server = loadMcpServer({ configPath });
  assert.equal(server.url, "http://example.invalid/mcp");
  assert.equal(server.headers.Authorization, "Basic top-secret");
});

test("parses JSON and SSE MCP responses and extracts hits", () => {
  const value = { jsonrpc: "2.0", id: 1, result: { structuredContent: { hits: [{ id: 1 }] } } };
  assert.deepEqual(extractHits(parseMcpResponse(JSON.stringify(value))), [{ id: 1 }]);
  assert.deepEqual(extractHits(parseMcpResponse(`event: message\ndata: ${JSON.stringify(value)}\n\n`)), [{ id: 1 }]);
});

test("builds the verified SearchSQL request shape", async () => {
  let sent;
  const result = await searchSql({
    server: { url: "http://example.invalid/mcp", headers: { Authorization: "Basic secret" } },
    orgId: "zhejiang",
    sql: "SELECT 1",
    startUs: 1,
    endUs: 2,
    from: 0,
    size: 1000,
    fetchImpl: async (_url, init) => {
      sent = JSON.parse(init.body);
      return response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { structuredContent: { hits: [{ value: 1 }], total: 1, took: 3 } },
      }));
    },
  });

  assert.equal(sent.params.name, "tools_call");
  assert.equal(sent.params.arguments.tool, "SearchSQL");
  assert.deepEqual(sent.params.arguments.args, {
    org_id: "zhejiang",
    type: "logs",
    request_body: {
      query: { sql: "SELECT 1", start_time: 1, end_time: 2, from: 0, size: 1000 },
    },
  });
  assert.equal(sent.params.arguments.detail, "full");
  assert.deepEqual(result.hits, [{ value: 1 }]);
});

test("paginates until a short page", async () => {
  const offsets = [];
  const pages = new Map([
    [0, [{ id: 1 }, { id: 2 }]],
    [2, [{ id: 3 }]],
  ]);
  const result = await searchAllSql({
    server: { url: "http://example.invalid/mcp", headers: {} },
    orgId: "zhejiang",
    sql: "SELECT id FROM vss_log",
    startUs: 1,
    endUs: 2,
    pageSize: 2,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const offset = body.params.arguments.args.request_body.query.from;
      offsets.push(offset);
      return response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { structuredContent: { hits: pages.get(offset) ?? [] } },
      }));
    },
  });

  assert.deepEqual(offsets, [0, 2]);
  assert.deepEqual(result.hits, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.equal(result.requests, 2);
});

test("does not expose Authorization values in errors", async () => {
  await assert.rejects(
    searchSql({
      server: { url: "http://example.invalid/mcp", headers: { Authorization: "Basic secret-value" } },
      orgId: "zhejiang",
      sql: "SELECT 1",
      startUs: 1,
      endUs: 2,
      from: 0,
      size: 1,
      fetchImpl: async () => response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32603, message: "bad request" },
      })),
    }),
    (error) => error.message.includes("bad request") && !error.message.includes("secret-value"),
  );
});
