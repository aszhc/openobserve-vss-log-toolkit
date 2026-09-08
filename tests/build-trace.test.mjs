import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  formatStart,
  makeFilename,
  redactCredentialValues,
  renderTrace,
  writeTrace,
  writeTraceRows,
} from "../scripts/build-trace.mjs";

test("formats the reference filename in Asia/Shanghai", () => {
  assert.equal(
    makeFilename({
      direction: "mo",
      phone: "+86 15967308074",
      start: "2026-06-04T12:19:13.000Z",
    }),
    "MO_8615967308074_20260604201913.trace",
  );
  assert.equal(formatStart("20260604201913"), "20260604201913");
});

test("sorts rows and puts every raw_message on a newline", () => {
  const result = renderTrace([
    { _timestamp: 3, raw_message: "third" },
    { _timestamp: 1, raw_message: "first\n" },
    { _timestamp: 2, raw_message: "second" },
    { _timestamp: 4, raw_message: null },
  ]);
  assert.equal(result.content, "first\nsecond\nthird\n");
  assert.equal(result.inputRows, 4);
  assert.equal(result.count, 3);
  assert.equal(result.skippedNull, 1);
});

test("redacts credential values without masking phone numbers", () => {
  const result = redactCredentialValues(
    'calling=8615967308074 token=secret&next=1 {"Authorization":"Basic abc"}',
  );
  assert.equal(
    result.value,
    'calling=8615967308074 token=<redacted>&next=1 {"Authorization":"<redacted>"}',
  );
  assert.equal(result.count, 2);
});

test("writes a trace from a SearchSQL hits object without overwriting by default", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vss-trace-test-"));
  const input = path.join(root, "rows.json");
  fs.writeFileSync(
    input,
    JSON.stringify({ hits: [{ _timestamp: 1, raw_message: "one" }, { _timestamp: 2, raw_message: "two" }] }),
  );
  const options = {
    input,
    outputDir: root,
    direction: "MT",
    phone: "8613800138000",
    start: "20260908155427",
    force: false,
  };
  const result = writeTrace(options);
  assert.equal(result.filename, "MT_8613800138000_20260908155427.trace");
  assert.equal(fs.readFileSync(result.outputPath, "utf8"), "one\ntwo\n");
  assert.equal(result.inputRows, 2);
  assert.equal(result.skippedNull, 0);
  assert.throws(() => writeTrace(options), /EEXIST/);
});

test("writes a trace directly from row data", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vss-trace-rows-test-"));
  const result = writeTraceRows(
    [{ _timestamp: 2, raw_message: "two" }, { _timestamp: 1, raw_message: "one" }],
    {
      outputDir: root,
      direction: "MT",
      phone: "8618368352203",
      start: "2026-09-08T08:36:41.240Z",
      force: false,
    },
  );
  assert.equal(result.filename, "MT_8618368352203_20260908163641.trace");
  assert.equal(fs.readFileSync(result.outputPath, "utf8"), "one\ntwo\n");
  assert.throws(
    () => writeTraceRows([{ _timestamp: 1, raw_message: "one" }], {
      outputDir: root,
      direction: "MT",
      phone: "8618368352203",
      start: "2026-09-08T08:36:41.240Z",
      force: false,
    }),
    /EEXIST/,
  );
});
