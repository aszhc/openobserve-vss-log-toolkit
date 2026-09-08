import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildBillSql,
  buildVssSql,
  normalizeCallPhone,
  parseArgs,
  runFastCallTrace,
} from "../scripts/fast-call-trace.mjs";

test("parses CLI arguments and safely quotes SQL values", () => {
  const options = parseArgs([
    "--phone", "8618368352203",
    "--at", "2026-09-08 16:36",
    "--window-minutes", "5",
    "--output-dir", "./traces",
  ]);
  assert.equal(options.phone, "8618368352203");
  assert.equal(options.windowMinutes, 5);
  assert.match(buildBillSql("86'123"), /86''123/);
  assert.match(buildVssSql("track'id"), /track''id/);
  assert.equal(normalizeCallPhone("198-5706-3897"), "8619857063897");
  assert.equal(normalizeCallPhone("8619857063897"), "8619857063897");
});

test("uses one bill lookup and one logical VSS lookup to summarize and export", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-call-trace-"));
  const calls = [];
  const bill = {
    _timestamp: 1788856626752183,
    callidentifier: "call07-01-00000322-25-ee4a47990f0be-8618368352203",
    calling: "10088",
    called: "8618368352203",
    direction: "MT",
    duration: "23.000000",
    bearercapability: "AUDIO",
    time: "2026-09-08T16:37:04.163+0800",
  };
  const lifecycle = [
    ["BEGIN", "2026-09-08T08:36:41.240Z"],
    ["RINGING", "2026-09-08T08:36:43.120Z"],
    ["ANSWER", "2026-09-08T08:36:54.080Z"],
    ["RELEASE", "2026-09-08T08:37:03.940Z"],
  ].map(([event, timestamp], index) => ({
    _timestamp: Date.parse(timestamp) * 1000 + index,
    labels_code: "呼叫事件通知接口",
    labels_event: event,
    protocol_request_body: JSON.stringify({
      callEvent: {
        event,
        timestamp,
        direction: "MT",
        calling: "10088",
        called: "8618368352203",
        bearerCapability: "AUDIO",
      },
    }),
    raw_message: `${event} raw`,
  }));
  const rows = [
    ...lifecycle,
    {
      _timestamp: 1788856614895516,
      labels_code: "呼叫事件通知",
      labels_event: "ANSWER",
      labels_appid: "1101030000000202",
      raw_message: "business raw",
    },
    ...Array.from({ length: 78 }, (_value, index) => ({
      _timestamp: 1788856616000000 + index,
      raw_message: `filler ${index}`,
    })),
  ];

  const result = await runFastCallTrace({
    phone: "8618368352203",
    at: "2026-09-08 16:36",
    windowMinutes: 10,
    outputDir,
    orgId: "zhejiang",
    server: { url: "http://example.invalid/mcp", headers: { Authorization: "Basic secret" } },
  }, {
    searchSqlImpl: async (query) => {
      calls.push(query);
      return { hits: [bill], took: 1, scanRecords: 10 };
    },
    searchAllSqlImpl: async (query) => {
      calls.push(query);
      return { hits: rows, requests: 1, took: 2, scanRecords: 20 };
    },
    appCatalog: new Map([["1101030000000202", "浙江AI速记"]]),
  });

  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /FROM call_bill/);
  assert.match(calls[1].sql, /FROM vss_log/);
  assert.match(calls[1].sql, /raw_message/);
  assert.match(calls[1].sql, /protocol_request_body/);
  assert.match(calls[1].sql, /trackid = 'call07-01-00000322-25-ee4a47990f0be-8618368352203'/);
  assert.equal(result.queryStats.networkRequests, 2);
  assert.equal(result.queryStats.vssRows, 83);
  assert.equal(result.trace.recordsWritten, 83);
  assert.equal(result.trace.filename, "MT_8618368352203_20260908163641.trace");
  assert.equal(result.lifecycle.answered, true);
  assert.equal(result.businesses[0].businessName, "浙江AI速记");
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /BEGIN raw|Basic secret/);
  assert.equal(fs.readFileSync(result.trace.outputPath, "utf8").split("\n").length, 84);
});
