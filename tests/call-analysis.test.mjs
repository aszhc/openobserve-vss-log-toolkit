import assert from "node:assert/strict";
import test from "node:test";

import {
  makeWindow,
  parseJsonValue,
  parseTargetTime,
  selectNearestBill,
  summarizeCall,
} from "../scripts/lib/call-analysis.mjs";

test("parses local Shanghai time and creates a microsecond window", () => {
  const target = parseTargetTime("2026-09-08 16:36");
  assert.equal(new Date(target).toISOString(), "2026-09-08T08:36:00.000Z");
  assert.deepEqual(makeWindow(target, 10), {
    startUs: Date.parse("2026-09-08T08:26:00.000Z") * 1000,
    endUs: Date.parse("2026-09-08T08:46:00.000Z") * 1000,
  });
});

test("selects the nearest bill and reports an equidistant conflict", () => {
  const target = Date.parse("2026-09-08T08:36:00.000Z");
  const nearest = selectNearestBill([
    { callidentifier: "far", time: "2026-09-08T16:30:00.000+0800" },
    { callidentifier: "near", time: "2026-09-08T16:36:10.000+0800" },
  ], target);
  assert.equal(nearest.callidentifier, "near");

  assert.throws(
    () => selectNearestBill([
      { callidentifier: "left", time: "2026-09-08T16:35:50.000+0800" },
      { callidentifier: "right", time: "2026-09-08T16:36:10.000+0800" },
    ], target),
    /left.*right|right.*left/,
  );
});

test("parses object and nested JSON string values", () => {
  assert.deepEqual(parseJsonValue({ ok: true }), { ok: true });
  assert.deepEqual(parseJsonValue('"{\\"ok\\":true}"'), { ok: true });
  assert.equal(parseJsonValue("not-json"), null);
});

test("summarizes lifecycle, business notifications, controls, and raw count", () => {
  const trackid = "call-test";
  const event = (name, timestamp, extra = {}) => ({
    _timestamp: Date.parse(timestamp) * 1000,
    trackid,
    labels_code: "呼叫事件通知接口",
    labels_event: name,
    protocol_request_body: JSON.stringify({
      callEvent: {
        event: name,
        timestamp,
        direction: "MT",
        calling: "10088",
        called: "8618368352203",
        bearerCapability: "AUDIO",
        ...extra,
      },
    }),
    raw_message: `${name} raw`,
  });
  const rows = [
    event("BEGIN", "2026-09-08T08:36:41.240Z"),
    event("RINGING", "2026-09-08T08:36:43.120Z"),
    event("ANSWER", "2026-09-08T08:36:54.080Z"),
    event("RELEASE", "2026-09-08T08:37:03.940Z", {
      reason: { protocol: "SIP", cause: "200", text: "User Triggered" },
    }),
    {
      _timestamp: 5,
      labels_code: "呼叫事件通知",
      labels_event: "BEGIN",
      labels_appid: "1101030000000202",
      raw_message: "notify",
    },
    {
      _timestamp: 6,
      labels_code: "呼叫事件通知",
      labels_event: "RINGING",
      labels_appid: "1101030000000202",
      raw_message: "notify",
    },
    {
      _timestamp: 7,
      labels_code: "呼叫事件通知",
      labels_event: "ANSWER",
      labels_appid: "1101030000000202",
      raw_message: "notify",
    },
    {
      _timestamp: 8,
      labels_code: "呼叫事件通知",
      labels_event: "RELEASE",
      labels_appid: "1101030000000202",
      raw_message: "notify",
    },
    {
      _timestamp: 9,
      labels_code: "呼叫事件控制接口",
      labels_appid: "1101030000000202",
      labels_operation_0: "AV_CONTROL@ANCHOR@ANCHOR",
      raw_message: "control",
    },
    {
      _timestamp: 10,
      labels_code: "呼叫控制结果通知",
      labels_appid: "1101030000000202",
      labels_operationresult_0: "SUCCESS@SUCCESS@SUCCESS",
      raw_message: "result",
    },
    { _timestamp: 11, raw_message: null },
  ];

  const summary = summarizeCall({
    bill: {
      callidentifier: trackid,
      calling: "10088",
      called: "8618368352203",
      direction: "MT",
      duration: "23.000000",
      bearercapability: "AUDIO",
      time: "2026-09-08T16:37:04.163+0800",
    },
    rows,
    appCatalog: new Map([["1101030000000202", "浙江AI速记"]]),
  });

  assert.equal(summary.answered, true);
  assert.equal(summary.released, true);
  assert.equal(summary.setupSeconds, 12.84);
  assert.equal(summary.connectedSeconds, 9.86);
  assert.equal(summary.observedSeconds, 22.7);
  assert.equal(summary.rawMessages, 10);
  assert.deepEqual(summary.businesses[0], {
    appid: "1101030000000202",
    businessName: "浙江AI速记",
    notifiedEvents: ["BEGIN", "RINGING", "ANSWER", "RELEASE"],
    operations: ["AV_CONTROL@ANCHOR@ANCHOR"],
    operationResults: ["SUCCESS@SUCCESS@SUCCESS"],
  });
  assert.deepEqual(summary.releaseReason, {
    protocol: "SIP",
    cause: "200",
    text: "User Triggered",
  });
});

test("splits comma-delimited appids instead of creating a composite unknown business", () => {
  const summary = summarizeCall({
    bill: { callidentifier: "call", direction: "MO", duration: 1 },
    rows: [{
      _timestamp: 1,
      labels_code: "呼叫控制",
      labels_appid: "0001010000000037,0002010000000002",
      labels_operation_0: "ANCHOR",
      raw_message: "raw",
    }],
    appCatalog: new Map([
      ["0001010000000037", "视频插播"],
      ["0002010000000002", "智能翻译"],
    ]),
  });
  assert.deepEqual(summary.businesses.map((item) => item.appid), [
    "0001010000000037",
    "0002010000000002",
  ]);
});
