#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { writeTraceRows } from "./build-trace.mjs";
import {
  loadAppCatalog,
  makeWindow,
  parseTargetTime,
  selectNearestBill,
  summarizeCall,
} from "./lib/call-analysis.mjs";
import {
  findProjectMcpConfig,
  loadMcpServer,
  searchAllSql,
  searchSql,
} from "./lib/openobserve-mcp.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  return [
    "Usage:",
    "  node scripts/fast-call-trace.mjs --phone <number> --at <timestamp> [options]",
    "",
    "Options:",
    "  --window-minutes <n>  Search radius before and after --at (default: 10)",
    "  --output-dir <path>   Trace output directory (default: current directory)",
    "  --config <path>       Project MCP config (default: find .mcp.json upward)",
    "  --server <name>       MCP server name (default: openobserve)",
    "  --org-id <id>         OpenObserve organization (default: env or MCP URL)",
    "  --page-size <n>       VSS page size (default: 1000)",
    "  --force               Overwrite an existing trace file",
  ].join("\n");
}

export function parseArgs(argv) {
  const options = {
    windowMinutes: 10,
    outputDir: process.cwd(),
    serverName: "openobserve",
    pageSize: 1000,
    force: false,
  };
  const names = {
    "--phone": "phone",
    "--at": "at",
    "--window-minutes": "windowMinutes",
    "--output-dir": "outputDir",
    "--config": "configPath",
    "--server": "serverName",
    "--org-id": "orgId",
    "--page-size": "pageSize",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--force") {
      options.force = true;
      continue;
    }
    const key = names[arg];
    if (!key) throw new Error(`Unknown option: ${arg}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    options[key] = ["windowMinutes", "pageSize"].includes(key) ? Number(value) : value;
    index += 1;
  }
  if (!options.phone) throw new Error("Missing required option: --phone");
  if (!options.at) throw new Error("Missing required option: --at");
  if (!Number.isFinite(options.windowMinutes) || options.windowMinutes <= 0) {
    throw new Error("--window-minutes must be positive");
  }
  if (!Number.isInteger(options.pageSize) || options.pageSize <= 0) {
    throw new Error("--page-size must be a positive integer");
  }
  return options;
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function normalizeCallPhone(value) {
  const digits = String(value).replace(/\D/g, "");
  if (!digits) throw new Error("Phone number is empty after normalization");
  return /^1\d{10}$/.test(digits) ? `86${digits}` : digits;
}

export function buildBillSql(phone, limit = 100) {
  const literal = sqlLiteral(phone);
  return [
    "SELECT _timestamp, callidentifier, calling, called, direction,",
    "       duration, bearercapability, areacode, time, details",
    "FROM call_bill",
    `WHERE calling = ${literal} OR called = ${literal}`,
    "ORDER BY _timestamp ASC",
    `LIMIT ${Number(limit)}`,
  ].join("\n");
}

export function buildVssSql(trackid) {
  return [
    "SELECT _timestamp, raw_message, trackid, labels_code, labels_event,",
    "       labels_direction, labels_caller, labels_callee, labels_appid,",
    "       protocol_labels_appid, labels_operation_0, labels_operation_1,",
    "       labels_operationresult_0, labels_operationresult_1,",
    "       protocol_request_body, protocol_response_code, code, protocol_code",
    "FROM vss_log",
    `WHERE trackid = ${sqlLiteral(trackid)}`,
    "ORDER BY _timestamp ASC",
  ].join("\n");
}

function inferOrgId(server) {
  if (process.env.OPENOBSERVE_ORG_ID) return process.env.OPENOBSERVE_ORG_ID;
  try {
    const match = new URL(server.url).pathname.match(/\/api\/([^/]+)\/mcp\/?$/);
    if (match) return decodeURIComponent(match[1]);
  } catch {
    // URL validity is checked when configuration is loaded.
  }
  throw new Error("OpenObserve org ID is required; use --org-id or OPENOBSERVE_ORG_ID");
}

function compactBill(bill) {
  return {
    callidentifier: bill.callidentifier,
    calling: bill.calling,
    called: bill.called,
    direction: bill.direction,
    duration: Number(bill.duration),
    bearerCapability: bill.bearercapability,
    areaCode: bill.areacode,
    time: bill.time,
  };
}

function compactLifecycle(summary) {
  return {
    answered: summary.answered,
    released: summary.released,
    beginTime: summary.beginTime,
    ringingTime: summary.ringingTime,
    answerTime: summary.answerTime,
    releaseTime: summary.releaseTime,
    setupSeconds: summary.setupSeconds,
    connectedSeconds: summary.connectedSeconds,
    observedSeconds: summary.observedSeconds,
    releaseReason: summary.releaseReason,
    events: summary.lifecycle,
  };
}

export async function runFastCallTrace(options, dependencies = {}) {
  const startedAt = performance.now();
  const phone = normalizeCallPhone(options.phone);
  const targetMs = parseTargetTime(options.at);
  const windowMinutes = options.windowMinutes ?? 10;
  const window = makeWindow(targetMs, windowMinutes);

  const configPath = options.server
    ? options.configPath
    : findProjectMcpConfig(options.startDir ?? process.cwd(), options.configPath);
  const server = options.server ?? loadMcpServer({
    configPath,
    serverName: options.serverName ?? "openobserve",
  });
  const orgId = options.orgId ?? inferOrgId(server);
  const searchSqlImpl = dependencies.searchSqlImpl ?? searchSql;
  const searchAllSqlImpl = dependencies.searchAllSqlImpl ?? searchAllSql;

  const billStartedAt = performance.now();
  const billResult = await searchSqlImpl({
    server,
    orgId,
    sql: buildBillSql(phone),
    startUs: window.startUs,
    endUs: window.endUs,
    from: 0,
    size: 100,
  });
  const billElapsedMs = performance.now() - billStartedAt;
  if (billResult.hits.length === 0) {
    throw new Error(`No call_bill row found for ${phone} in the requested time window`);
  }
  const bill = selectNearestBill(billResult.hits, targetMs);

  const vssStartedAt = performance.now();
  const vssResult = await searchAllSqlImpl({
    server,
    orgId,
    sql: buildVssSql(bill.callidentifier),
    startUs: window.startUs,
    endUs: window.endUs,
    pageSize: options.pageSize ?? 1000,
  });
  const vssElapsedMs = performance.now() - vssStartedAt;
  if (vssResult.hits.length === 0) {
    throw new Error(`No vss_log rows found for trackid ${bill.callidentifier}`);
  }

  const catalogPath = path.resolve(scriptDir, "../references/appid-catalog.md");
  const appCatalog = dependencies.appCatalog ?? loadAppCatalog(catalogPath);
  const summary = summarizeCall({ bill, rows: vssResult.hits, appCatalog });
  const earliest = [...vssResult.hits]
    .map((row) => Number(row._timestamp))
    .filter(Number.isFinite)
    .sort((left, right) => left - right)[0];
  const start = summary.beginTime ?? (earliest ? new Date(earliest / 1000).toISOString() : null);
  if (!bill.direction || !start) throw new Error("Direction or call start time could not be confirmed");

  const localStartedAt = performance.now();
  const trace = writeTraceRows(vssResult.hits, {
    outputDir: path.resolve(options.outputDir ?? process.cwd()),
    direction: bill.direction,
    phone,
    start,
    force: options.force ?? false,
  });
  const localElapsedMs = performance.now() - localStartedAt;

  return {
    query: {
      phone,
      targetTime: new Date(targetMs).toISOString(),
      startTime: new Date(window.startUs / 1000).toISOString(),
      endTime: new Date(window.endUs / 1000).toISOString(),
      orgId,
    },
    bill: compactBill(bill),
    lifecycle: compactLifecycle(summary),
    businesses: summary.businesses,
    queryStats: {
      networkRequests: 1 + (vssResult.requests ?? 1),
      billRows: billResult.hits.length,
      vssRows: vssResult.hits.length,
      rawMessages: summary.rawMessages,
      scanRecords: {
        bill: billResult.scanRecords,
        vss: vssResult.scanRecords,
      },
      elapsedMs: {
        bill: Math.round(billElapsedMs),
        vss: Math.round(vssElapsedMs),
        local: Math.round(localElapsedMs),
        total: Math.round(performance.now() - startedAt),
      },
    },
    trace,
  };
}

async function main() {
  try {
    const result = await runFastCallTrace(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
