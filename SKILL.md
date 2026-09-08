---
name: openobserve-vss-log-toolkit
description: Use whenever a user asks to query, analyze, compare, troubleshoot, summarize, or export OpenObserve VSS logs, including sign-up/contract synchronization, unsubscribe synchronization, DC business activation or cancellation, call event notifications, call lifecycle, call start/answer/release, call bills, call_bill, raw_message, trackid trace export, .trace files, business appid, appid-to-business mapping, vss_log, labels_code, protocol_request_uri, or protocol_request_body. Use this skill even when the user says "查日志" or "获取通话日志" without naming SQL, as long as the request concerns VSS or OpenObserve logs.
---

# OpenObserve VSS log toolkit

Use this skill for read-only investigation of VSS logs through the connected OpenObserve MCP. Treat the remote MCP as the execution layer and this document as the business-query contract. Do not invent fields, organization IDs, event mappings, or results.

This skill requires an MCP client connected to an OpenObserve HTTP/Streamable HTTP server with the `SearchSQL`, `StreamSchema`, and `StreamList` tools available.

## Intent-to-query mapping

Use this decision table before building SQL:

| User intent | Stream | `labels_code` |
|---|---|---|
| 单用户业务签约同步 / 签约日志 | `vss_log` | `单用户业务签约同步` |
| 单用户业务退订信息同步 / 退订日志 | `vss_log` | `单用户业务退订信息同步` |
| DC 业务开通/签约或退订 | `vss_log` | `单用户新通话功能开通同步` |
| 通话事件通知 / 通话开始 | `vss_log` | `呼叫事件通知接口` |
| 话单/计费摘要 | `call_bill` | 不使用 `labels_code`；按 `callidentifier` 精确关联 |
| 导出通话原始日志 / `.trace` | `vss_log` | 不限制 `labels_code`；按 `trackid` 查询 `raw_message` |

Use `vss_log` as the default stream for these events. Use the configured `OPENOBSERVE_ORG_ID` for MCP arguments; never invent or silently substitute a different organization. Read [references/business-events.md](references/business-events.md) for synonyms and combined-event queries when needed.

For the DC event, inspect `protocol_request_body.op`: `"ADD"` means 签约DC and `"DELETE"` means 退订DC. Parse the body as an object or JSON string; an absent or unknown `op` is unresolved and must not be classified silently.

For call-event notifications, parse `protocol_request_body.callEvent`. `event="BEGIN"` is the call-start event; other observed lifecycle events include `RINGING`, `ANSWER`, `MEDIA_UPDATE_REQUEST`, and `RELEASE`. Useful dimensions include `direction` (`MO`/`MT`/`CF`), `notificationMode` (`NOTIFY`/`BLOCK`), `bearerCapability` (`AUDIO`/`VIDEO`/`AUDIO&DC`), `calling`, `called`, `redirecting`, `reason`, `location`, `callUrl`, and `icid`. When the schema confirms extracted fields such as `labels_caller`, `labels_callee`, `labels_event`, and `labels_direction`, use those fields to narrow the initial phone/event lookup and keep the body for final parsing; otherwise fall back to a bounded body search. The confirmed cross-stream join is `call_bill.callidentifier = vss_log.trackid`; use that exact equality as the primary association and retain the event time window. The parsed `callEvent.callIdentifier` may validate or recover a missing key, but do not broad-scan `call_bill` with `LIKE`. For call-event logs, the phone numbers are not normally in the fixed callback URI `/v1/vss/sessions-followup/call-event`; they are in the structured labels or parsed body.

The business `appid` is normally found in `protocol_request_body`; observed sign-up rows use an `appIds` array, so parse `appid`, `appId`, and `appIds` variants according to the actual payload. After extraction, map each string-valued appid through [references/appid-catalog.md](references/appid-catalog.md) and report the business name when it is listed. Preserve leading zeroes, keep multiple array values separate, and label an unlisted value as `未知业务（目录未收录）`; never infer a name from a prefix or similar text. Read [references/field-mapping.md](references/field-mapping.md) when the field shape, success/failure field, or fallback behavior is unclear.

In `vss_log`, `trackid` identifies one complete request chain. In the current environment, sign-up URIs look like `/v1/vonr/subscription/users/861...` and DC URIs like `/v1/vonr/subscription/dc-ability/861...`; after confirming the event-specific template, prefer exact equality on the full URI because it is faster than a contains scan. If the user supplies an 11-digit Chinese mobile number and the observed template uses an `86` prefix, add that prefix once; otherwise preserve the observed normalization. Find matching rows, retain their `trackid` values, then retrieve and order the rows belonging to each chain. Use `protocol_request_body` for `appid` and DC `op` extraction, not as the phone filter. Treat the final chain outcome as successful only when the relevant status or result field has been confirmed.

For a complete call investigation, prefer a bill-first lookup when the user gives a phone number: query the bounded `call_bill` stream by exact `calling`/`called` equality to get a quick summary and `callidentifier`, then query `vss_log` by that exact `trackid` to reconstruct the detailed protocol chain. If the bill-first query returns no row, fall back to a bounded call-event search in `vss_log` and then associate any discovered key. For a supplied `trackid`, skip the phone lookup and query `call_bill` directly with `callidentifier = '<trackid>'`. `call_bill.duration` is the preferred billed/summary duration, `time` is the bill record time, and `details` is a JSON array of lifecycle and operation records. Details may contain `name`, `event`, `protocolCode`, `cause`, per-operation `duration`, `sender`, `receiver`, `operation_0`, `result`, and timestamps. Use `call_bill` to supplement final duration, direction, parties, bearer, area code, and operation outcomes, while using `vss_log` for the full protocol chain. In the current environment, `call_bill.callidentifier` has an index and Bloom filter, and the bill-first phone lookup scans far fewer records than searching unstructured vss bodies.

When reconstructing a call chain, inspect non-event control rows for triggered capabilities as well as appid fields. In `呼叫事件控制接口`, `protocol_request_body.actions[].operation = "DC_CONTROL"` with `dcControl[].dcAction = "CREATE"` indicates an attempted DC capability activation during the call. Match it with `呼叫控制结果通知` and read `actionResults[].operationResult` / `dcControlResult[].dcStatus`: `SUCCESS` means the capability operation succeeded, `FAILURE` means it was triggered but failed. This runtime DC operation is distinct from the subscription label `单用户新通话功能开通同步`; do not claim an appid when the call chain has no appid field.

## Fast call lookup

When the user supplies a phone number and target time and wants call analysis or a trace export, prefer `scripts/fast-call-trace.mjs`. It performs one bill lookup and one logical exact-trackid VSS query, then summarizes lifecycle, appids, controls, and trace output locally. Do not separately query lifecycle, appids, control results, or raw messages after this command succeeds. Use the manual SearchSQL workflow only when the script is unavailable, the MCP configuration is incompatible, or the request is outside the command's supported phone-and-time lookup.

Example:

```bash
node scripts/fast-call-trace.mjs \
  --phone 8618368352203 \
  --at "2026-09-08 16:36" \
  --window-minutes 10 \
  --output-dir ./traces
```

The command reads the project-level `.mcp.json`, emits one compact JSON result, and never prints raw messages or authentication headers. A normal single-page call uses two network requests. Read [references/trace-export.md](references/trace-export.md) for the command contract and fallback behavior.

## Read-only query procedure

Follow this sequence for every investigation:

1. Identify the event (sign-up, unsubscribe, DC activation/cancellation, call lifecycle, comparison, a specified `appid`, or troubleshooting) and the desired output. Apply the mapping above.
2. Confirm a start and end time. If the user did not provide a time range, ask for it before querying; never silently scan all history. Use the user's timezone unless they specify another one.
3. Convert the range to valid, non-zero microsecond timestamps. Ensure the end is after the start and retain the human-readable range in the response.
4. Use `StreamSchema` first when the user asks about an unknown field, when the shape of `protocol_request_body` is unclear, or when a success/failure field has not been confirmed. Use `StreamList` only to verify stream availability or discover a requested stream.
5. Call `SearchSQL` with the configured `org_id`, `type: "logs"`, and a request body containing `query.sql`, `query.start_time`, `query.end_time`, `query.from`, and `query.size`. Keep the SQL bounded by the supplied time range and use pagination deliberately.
6. Prefer `agent_options.output_format: "md_table"` for small result sets and `"csv"` for larger tabular results. Use `detail: "full"` when formatted result data is needed for parsing or reporting.
7. For every returned row, parse `protocol_request_body` as either a JSON object or a JSON-encoded string. Extract the business `appid` without guessing, preserve it as a string, and map it through `references/appid-catalog.md`; for DC rows also classify `op=ADD` as 签约DC and `op=DELETE` as 退订DC. Preserve an explicit note when the body is missing, invalid JSON, has no appid, contains multiple candidates, or has an unknown/missing `op`.
8. Summarize by `appid`, success/failure status (only when the relevant status field is confirmed), record count, and latest timestamp. For large result sets, return the aggregate first and representative samples only when useful.

For call-event analysis, keep the minimal fields `_timestamp`, `protocol_request_body`, `protocol_request_timestamp`, `protocol_response_timestamp`, `code`, `protocol_code`, `protocol_response_code`, and `trackid`. Parse and group the `callEvent` payload by a validated correlation key, sort by the call-event timestamp, and derive setup latency (`BEGIN`→`ANSWER`), observed duration (`BEGIN`→`RELEASE`), lifecycle gaps, directions, media capability, and release reasons only when both endpoints are present. A `BEGIN` row alone proves an observed start notification, not that the call was answered.

For a phone-number call investigation, query `call_bill` first with exact `calling = '<normalized-number>' OR called = '<normalized-number>'` and a bounded time range. Select `_timestamp`, `callidentifier`, `calling`, `called`, `direction`, `duration`, `bearercapability`, `areacode`, `time`, and `details`; parse `details` locally as a JSON array and summarize its event/operation outcomes. Then use each returned `callidentifier` as the exact `trackid` in a bounded `vss_log` query. Keep the two result sets separate so a missing vss chain or bill row is visible rather than mistaken for a failed call.

For a phone-number investigation, first use an exact `protocol_request_uri` constructed from the confirmed event template (for example `/v1/vonr/subscription/users/<normalized-number>` for sign-up or `/v1/vonr/subscription/dc-ability/<normalized-number>` for DC). Use a bounded `LIKE`/substring fallback only when the URI template is not yet known. Group matching rows by `trackid`, sort each group by the confirmed timestamp field, and report the chain timeline. Follow the current project preference to show phone numbers in full. Do not invent a URI parameter name or switch to `protocol_request_body` for phone filtering.

For a call-log export, read [references/trace-export.md](references/trace-export.md). Prefer `scripts/fast-call-trace.mjs` when phone and target time are available. On the manual fallback, query the combined VSS field set once by exact `trackid`, paginate until all rows are retrieved, and reuse those rows for summary and trace creation; do not issue separate lifecycle and `raw_message` queries. Write every non-null `raw_message` to a UTF-8 `.trace` file with a newline after each value. The filename is `<DIRECTION>_<PHONE>_<CALL_START_YYYYMMDDHHMMSS>.trace`, for example `MO_8615967308074_20260604201913.trace`; prefer the user-supplied target phone, call direction, and the BEGIN timestamp in `Asia/Shanghai`. Return the absolute file path and record count. Do not overwrite an existing file unless the user explicitly requests it.

Use the SQL templates in [references/query-patterns.md](references/query-patterns.md) when constructing the request. Use the response contract in [references/result-format.md](references/result-format.md) for the final answer.

### Request invariants

- `query.start_time` and `query.end_time` must be non-zero microsecond timestamps.
- `query.from` and `query.size` must be explicit pagination values; start with a bounded page size appropriate to the request.
- Include the event's exact `labels_code` predicate unless the user explicitly requests a combined sign-up/unsubscribe comparison.
- Keep `protocol_request_body` in the selected fields whenever `appid` extraction is required.
- Keep `protocol_request_body` in the selected fields for DC queries because `op` determines 签约DC versus 退订DC.
- Keep `protocol_request_body` in the selected fields for call-event queries because lifecycle, phone roles, and release reasons are nested under `callEvent`.
- Keep `protocol_request_uri` in the selected fields whenever phone filtering or URI evidence is required.
- Keep `trackid` in the selected fields whenever a request-chain timeline is required.
- For `.trace` export, select `_timestamp` and `raw_message`, use `detail: "full"`, and paginate until all matching rows have been retrieved; summary-mode truncation is not a complete export.
- Prefer a minimal field list (`_timestamp`, `labels_code`, `protocol_request_uri`, `protocol_request_body`, confirmed status fields, and `trackid`) over `SELECT *` for phone lookups.
- If a query reports a large `scan_records` count, narrow the time window and report the scan cost; for genuinely large ranges use `agent_options.mode: "partition"` instead of manually looping over partitions.
- If a failure predicate is requested but its field is unknown, inspect `StreamSchema` or a small sample before filtering. Do not guess names such as `status`, `success`, or `error`.

## Allowed tools and safety boundary

Use only read-oriented tools for this skill, as relevant to the request: `SearchSQL`, `StreamSchema`, `StreamList`, `GetLatestTraces`, `PrometheusRangeQuery`, `SearchAround`, and `ListIncidents`. The core VSS workflow normally needs only `SearchSQL`, `StreamSchema`, and `StreamList`.

Do not call ingestion, create, update, move, enable, disable, retrain, or delete tools. This includes tools that write logs or modify Streams, alerts, dashboards, folders, reports, SLOs, users, roles, pipelines, or service accounts. Creating the user-requested local `.trace` artifact is allowed and does not modify OpenObserve. If the user requests another remote mutation, explain that this toolkit is read-only and stop before invoking it.

Never reveal the authorization header, token, environment variable value, or other credentials in output. Report connection and permission errors without exposing request secrets.

## Failure behavior

Handle each condition explicitly:

- **Missing time range:** ask for start and end time; do not run an unbounded query.
- **No results:** state the exact event, stream, filters, and time range searched; do not infer that the event never occurred.
- **Missing `protocol_request_body`:** report how many rows could not be inspected and retain other available row context.
- **Invalid JSON:** report parse failures and preserve a safe, abbreviated raw-field indication when useful; do not fabricate an `appid`.
- **Missing `appid`:** classify the row as unresolved and say that no appid was found.
- **Multiple `appid` candidates:** list the candidates only if they are actually present, mark the row ambiguous, and do not choose one silently.
- **MCP connection failure:** report that the OpenObserve MCP could not be reached and include the non-secret error text if available.
- **Permission failure:** report that the configured account lacks access to the requested read operation or stream; do not retry with a different credential or organization.
- **Unknown schema or status semantics:** inspect `StreamSchema` or a bounded sample and state any remaining uncertainty.
- **DC action unknown:** if `op` is missing, invalid, or outside `ADD`/`DELETE`, report “DC动作未确认” and do not force it into sign-up or unsubscribe.
- **Call event lookup:** filter the exact call-event `labels_code`, retrieve a bounded sample, parse phone numbers and lifecycle fields from `protocol_request_body.callEvent`, and do not pretend the fixed URI contains the phone.
- **Phone or chain lookup:** confirm the timestamp and phone fields with `StreamSchema` or a bounded sample; for sign-up/DC filter the supplied number in the confirmed URI, for call bills filter exact `calling`/`called`, use `trackid` to correlate rows, and follow the current full-number output preference.
- **Call-bill lookup:** use exact `call_bill.callidentifier = vss_log.trackid` after a bounded vss lookup. If no exact bill row is found, report the missing association and do not infer billing duration; use `callEvent.callIdentifier` only as a validated fallback. Parse `details` as a JSON array when present and report malformed or incomplete details separately.
- **Trace export:** if `raw_message` is absent from every row, do not create an empty file; report the trackid and time range searched. Report skipped null values and any pagination limit. If direction, phone, or call-start time cannot be confirmed, request the missing filename metadata instead of inventing it. Refuse to overwrite an existing file unless the user explicitly asks.

Phone numbers are shown in full by the current project preference. Never reveal authentication tokens. For `.trace` export, preserve raw log text except that Authorization, Cookie, password, and token credential values must be redacted before writing.

## Response contract

Respond in Chinese unless the user asks for another language. Follow [references/result-format.md](references/result-format.md), in this order:

1. 查询条件：事件、Stream、时间范围、组织（without secrets）、filters, and pagination.
2. 结果摘要：record count, distinct/resolved `appid` count, and success/failure counts when supported by confirmed fields.
3. 按 `appid` 的业务明细：include `appid`, matched `business_name` from the catalog, `记录数`, `成功数`, `失败数`, and `最近时间` when available.
4. 按 `trackid` 的请求链路：include the chain ID, ordered event summary, appid, and final status when a phone or chain lookup was requested. Follow the current project preference to show phone numbers in full.
5. 触发业务：for a call chain, report any resolved appid/business name and capability operations such as `DC_CONTROL`/`CREATE`, including the business outcome when a matching control-result row exists.
6. 话单补充：when a call investigation includes `call_bill`, report the association key, billed duration/time, direction, full calling/called numbers under the current project preference, bearer, and a concise `details` operation summary.
7. 代表性日志样例：include only when needed to explain a result or parse issue; redact unrelated sensitive values.
8. 异常与说明：no results, unresolved rows, parse failures, ambiguity, connection errors, or permission limitations.
9. 导出文件：when requested, include the absolute `.trace` path, filename metadata sources, total query rows, written `raw_message` count, skipped-null count, and whether credential redaction was applied.

Separate observed facts from interpretation. State the exact query filters and caveats so another Agent can reproduce the read-only investigation.

## Example behavior

For “查询昨天单用户业务签约同步失败的业务 appid，并统计每个 appid 的失败次数”:

1. Ask for the exact local start/end time if “昨天” cannot be resolved from context.
2. Use `vss_log` with `labels_code = '单用户业务签约同步'` and confirm the failure field through schema or a bounded sample.
3. Search with non-zero microsecond bounds, retain `protocol_request_body`, parse `appid`, and aggregate only observed failures.
4. Return the response contract and explicitly call out rows whose body or appid could not be parsed.

For “统计最近一天 DC 签约和退订数量”:

1. Query `vss_log` with `labels_code = '单用户新通话功能开通同步'` and an explicit time range.
2. Parse `protocol_request_body.op`; count `ADD` as 签约DC and `DELETE` as 退订DC.
3. Report unknown or malformed actions separately and keep the workflow read-only.

For “分析最近一小时通话开始、接通和释放情况”:

1. Query `labels_code = '呼叫事件通知接口'` with a bounded time range and minimal fields.
2. Parse `callEvent.event`, group by a validated `trackid`/`callIdentifier` relationship, and order each call timeline.
3. Report BEGIN/ANSWER/RELEASE counts, answer latency, release reasons, direction, media capability, and incomplete chains; show phone numbers in full under the current project preference, but omit credentials, IMEI, internal hosts, and call URLs.

For “根据 trackid 查询完整通话日志，并结合话单给出通话时长和结果”:

1. Query `vss_log` with `labels_code = '呼叫事件通知接口'` in the explicit time window and parse the lifecycle by `trackid`.
2. Query `call_bill` with exact `callidentifier = '<trackid>'` using the call's time window, optionally expanded by a small margin.
3. Parse `details` and combine its operation outcomes with `duration`, `time`, `direction`, `calling`, `called`, `bearercapability`, and `areacode`; distinguish observed protocol duration from billed summary duration and report missing bill rows.

For “根据 trackid 获取通话日志并导出 trace 文件”:

1. Resolve the bounded call time window, direction, target phone, and BEGIN time from the supplied context, `call_bill`, or the call-event chain.
2. Query all `_timestamp, raw_message` rows from `vss_log` with exact `trackid`, using full-detail pagination and ascending order.
3. Pass the collected hits to `scripts/build-trace.mjs`; return a file named like `MO_8615967308074_20260604201913.trace` and report how many raw messages were written.
