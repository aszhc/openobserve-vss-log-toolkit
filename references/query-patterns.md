# OpenObserve 查询模板

这些模板供 `SearchSQL` 使用。调用时必须把占位符替换为真实参数：

- `START_US`：查询开始时间，合法且非零的微秒时间戳；
- `END_US`：查询结束时间，合法且非零的微秒时间戳，且应晚于 `START_US`；
- `FROM`：分页起始位置，通常为非负整数；
- `SIZE`：本页记录数，使用合理的正整数上限。

时间范围缺失时先询问用户，不得默默查询全部历史。除 SQL 外，`SearchSQL` 请求还应带 `org_id`、`type: "logs"`，以及 `query.start_time`、`query.end_time`、`query.from`、`query.size` 等参数；组织 ID 使用配置的 `OPENOBSERVE_ORG_ID`。

## 性能策略

- 号码 URI 模板已确认时，优先用完整 `protocol_request_uri = '...'`，不要直接使用 `%号码%` 的 `LIKE`。
- 先查最小字段集，不要为号码定位使用 `SELECT *`；拿到 `trackid` 后再查询该链路需要的字段。
- 始终使用明确的微秒时间窗口和分页；大范围查询可使用 `agent_options.mode: "partition"`，不要由 Agent 手工拆分时间分区循环调用。
- 精确匹配仍可能扫描大量记录。若返回的 `scan_records` 很大，缩小时间窗口并报告这一事实；索引、Bloom filter 或专用字段优化属于 OpenObserve 管理侧变更，不由本只读工具包执行。

## 签约日志

```sql
SELECT *
FROM vss_log
WHERE labels_code = '单用户业务签约同步'
ORDER BY _timestamp DESC
LIMIT SIZE
```

请求参数中使用 `START_US` 和 `END_US` 限定时间，并用 `FROM` 实现分页。若当前环境的时间字段或排序字段不同，先用 `StreamSchema` 确认，不要臆测替换。

## 退订日志

```sql
SELECT *
FROM vss_log
WHERE labels_code = '单用户业务退订信息同步'
ORDER BY _timestamp DESC
LIMIT SIZE
```

## DC 业务日志

DC 签约和退订共用 `labels_code = '单用户新通话功能开通同步'`，必须读取 `protocol_request_body` 后按 `op` 分类。默认在 Agent 侧解析，不臆造 SQL JSON 路径：

```sql
SELECT _timestamp, labels_code, protocol_request_uri, protocol_request_body,
       protocol_response_code, code, protocol_code, trackid
FROM vss_log
WHERE labels_code = '单用户新通话功能开通同步'
ORDER BY _timestamp DESC
LIMIT SIZE
```

解析规则：`{"op":"ADD"}` → 签约DC；`{"op":"DELETE"}` → 退订DC。请求体可能是 JSON 对象或 JSON 字符串；缺失、非法 JSON、缺失 `op` 或其他动作值必须单独报告。

如果用户按号码查询 DC，且已确认当前 URI 模板，可把号码归一化后使用精确匹配，避免对整个 URI 做 `LIKE` 扫描：

```sql
SELECT _timestamp, labels_code, protocol_request_uri, protocol_request_body,
       protocol_response_code, code, protocol_code, trackid
FROM vss_log
WHERE protocol_request_uri = '/v1/vonr/subscription/dc-ability/<NORMALIZED_PHONE_VALUE>'
  AND labels_code = '单用户新通话功能开通同步'
ORDER BY _timestamp ASC
LIMIT SIZE
```

## 通话事件通知日志

一个通话的入口事件使用 `labels_code = '呼叫事件通知接口'`。当前 URI 多为固定回调路径，号码和生命周期字段在 `protocol_request_body.callEvent` 中，因此默认先取有界窗口的最小字段，再在 Agent 侧解析：

```sql
SELECT _timestamp, protocol_request_body, protocol_request_timestamp,
       protocol_response_timestamp, code, protocol_code,
       protocol_response_code, trackid
FROM vss_log
WHERE labels_code = '呼叫事件通知接口'
ORDER BY _timestamp DESC
LIMIT SIZE
```

解析 `callEvent.event` 并按已验证的 `trackid`/`callIdentifier` 关联键排序：`BEGIN` 表示开始通知，`RINGING`/`ANSWER` 表示振铃/接通，`MEDIA_UPDATE_REQUEST` 表示媒体更新，`RELEASE` 表示释放。号码查询应在解析后的 `calling`、`called`、`redirecting` 中匹配；由于这些号码嵌在请求体中，必须缩小时间范围并报告扫描成本。

若 `StreamSchema` 已确认结构化字段存在，号码定位优先使用 `labels_caller` / `labels_callee`，并同时保留 `labels_event`、`labels_direction`；这些字段比对整个 `protocol_request_body` 做文本搜索更省返回数据和解析成本。当前环境已观察到该字段组合：

```sql
SELECT _timestamp, labels_event, labels_direction,
       labels_caller, labels_callee, trackid
FROM vss_log
WHERE labels_code = '呼叫事件通知接口'
  AND labels_caller = '<NORMALIZED_PHONE_VALUE>'
ORDER BY _timestamp ASC
LIMIT SIZE
```

若结构化号码字段不存在或没有值，才退回 `protocol_request_body` 的有界 `str_match` 查询；无论哪种入口，拿到 `trackid` 后都应再查询整条链路，并报告 `scan_records`。

完整链路查询后，检查 `呼叫事件控制接口` 和 `呼叫控制结果通知` 的请求体：解析 `actions[].operation`、`dcControl[].dcAction`、`actionResults[].operationResult` 和 `dcControlResult[].dcStatus`，这样可以识别通话期间是否触发了 DC 能力以及操作是否成功。不要只根据接口 `code` 或 HTTP 状态判断业务结果。

## 话单优先的号码查询

用户只提供号码、想先了解通话概况时，优先查询 `call_bill`。先按 `calling` 或 `called` 精确匹配，在有界时间范围内获取话单摘要和 `callidentifier`，避免先对海量 `vss_log.protocol_request_body` 做全文搜索：

```sql
SELECT _timestamp, callidentifier, calling, called, direction,
       duration, bearercapability, areacode, time, details
FROM call_bill
WHERE calling = '<NORMALIZED_PHONE_VALUE>'
   OR called = '<NORMALIZED_PHONE_VALUE>'
ORDER BY _timestamp DESC
LIMIT SIZE
```

拿到每个 `callidentifier` 后，再执行下面的精确 `trackid` 关联查询。若 `call_bill` 无结果，才退回 `vss_log` 的结构化号码字段或 `protocol_request_body` 有界搜索。当前环境实测：三小时号码话单查询扫描约 250 万条记录；相比 vss 请求体搜索约 8400 万条，明显更适合作为第一步。

号码与目标时间已知时，优先运行 `scripts/fast-call-trace.mjs`。手工回退也必须用一次合并查询取得生命周期、业务、控制结果和原始日志，禁止为同一 trackid 分别查询这些内容：

```sql
SELECT _timestamp, raw_message, trackid, labels_code, labels_event,
       labels_direction, labels_caller, labels_callee, labels_appid,
       protocol_labels_appid, labels_operation_0, labels_operation_1,
       labels_operationresult_0, labels_operationresult_1,
       protocol_request_body, protocol_response_code, code, protocol_code
FROM vss_log
WHERE trackid = '<CONFIRMED_TRACKID>'
ORDER BY _timestamp ASC
```

使用 `query.from` / `query.size` 分页；同一批返回行同时供摘要和 `.trace` 写入使用。

## 按 trackid 关联 call_bill 话单

完整通话建议分两阶段查询：先用上面的 `vss_log` 查询得到并验证 `trackid`，再用该值作为 `call_bill.callidentifier` 的精确等值条件。`call_bill` 当前存在 `callidentifier` 索引和 Bloom filter，禁止用 `LIKE` 或只按时间扫描整条话单流。

```sql
SELECT _timestamp, callidentifier, calling, called, direction,
       duration, bearercapability, areacode, time, details
FROM call_bill
WHERE callidentifier = '<CONFIRMED_TRACKID>'
ORDER BY _timestamp ASC
LIMIT SIZE
```

请求参数仍必须带 `START_US`、`END_US`、`FROM` 和 `SIZE`。时间范围应覆盖 `vss_log` 中该通话的 `BEGIN` 到 `RELEASE`，若话单写入稍晚可在两端各扩展一个小窗口。`<CONFIRMED_TRACKID>` 只能替换为实际返回的 `trackid`，不得把用户输入未经查询验证的字符串直接当作关联成功。

`details` 通常是 JSON 数组，应在 Agent 侧解析并按其实际字段摘要 `name`、`event`、`protocolCode`、`cause`、单操作 `duration`、`sender`、`receiver`、`operation_0`、`result` 和时间戳。`duration` 用作话单/计费摘要时长，不能与 vss 事件的处理耗时混为一谈；`time` 用作话单时间。若无匹配行，报告“未找到对应话单”，不要推断通话时长或计费结果。

推荐的两阶段流程（用户给号码时话单优先；用户给 trackid 时直接从第二步开始）：

1. `call_bill`：按 `calling`/`called` 和时间范围取得话单摘要及 `callidentifier`。
2. `vss_log`：按 `trackid = '<callidentifier>'` 执行一次合并字段查询，从中筛选并解析 `呼叫事件通知接口`、业务通知、控制结果和 `raw_message`。
3. 合并输出：vss 提供 BEGIN/ANSWER/RELEASE 和原因，call_bill 提供话单摘要及操作明细；分别标注观察时长与话单时长，并报告两边缺失或不一致。

## 按 trackid 导出 raw_message

导出通话原始日志时，不加 `labels_code` 过滤，因为目标是保留该 trackid 下所有类型的链路日志：

```sql
SELECT _timestamp, raw_message
FROM vss_log
WHERE trackid = '<CONFIRMED_TRACKID>'
ORDER BY _timestamp ASC
LIMIT PAGE_SIZE
```

用已确认的通话时间窗口设置 `query.start_time` / `query.end_time`，并用 `query.from` / `query.size` 逐页读取。请求 `detail: "full"`；summary 模式最多返回 100 条，不能用于声称“完整导出”。全部页面合并后按 `_timestamp` 再排序，使用 [`../scripts/build-trace.mjs`](../scripts/build-trace.mjs) 写入文件。完整规则见 [trace-export.md](trace-export.md)。

## 合并查询

```sql
SELECT *
FROM vss_log
WHERE labels_code IN (
  '单用户业务签约同步',
  '单用户业务退订信息同步'
)
ORDER BY _timestamp DESC
LIMIT SIZE
```

合并结果必须保留 `labels_code`，之后分别汇总签约和退订，才能进行 appid 集合比较。

## 指定 appid 的查询

因为 `protocol_request_body` 的结构可能不同，不要在未确认 JSON 路径前直接臆造 SQL JSON 函数。先查询并在 Agent 侧解析请求体；确认路径和字段类型后，才可以在当前环境支持的语法下追加过滤。

```sql
SELECT *
FROM vss_log
WHERE labels_code = '单用户业务签约同步'
ORDER BY _timestamp DESC
LIMIT SIZE
```

## 失败日志查询

成功/失败字段不是固定约定。先调用 `StreamSchema` 或取得限定时间范围的样例，确认状态字段和失败值，再在上面的签约或退订过滤基础上追加条件。例如，只有在确认字段和值之后，才可形成类似下面的结构：

```sql
SELECT *
FROM vss_log
WHERE labels_code = '单用户业务签约同步'
  AND <CONFIRMED_FAILURE_FIELD> = '<CONFIRMED_FAILURE_VALUE>'
ORDER BY _timestamp DESC
LIMIT SIZE
```

`<CONFIRMED_FAILURE_FIELD>` 和 `<CONFIRMED_FAILURE_VALUE>` 只是占位符，不能原样发送，也不能用未验证的字段名替换。

## 按 appid 汇总

优先查询包含 `protocol_request_body` 的原始记录，在 Agent 侧解析 `appid` 后按 appid、`labels_code` 和确认过的成功/失败状态汇总。只有在已通过 Schema 确认 OpenObserve JSON 提取语法和路径时，才考虑数据库侧聚合；否则不要生成可能失效的 JSON 路径表达式。

## 时间点附近日志

若用户要排查某个时间点附近的事件，先将时间点转换成非零微秒时间戳并限定一个明确窗口，再使用 `SearchAround`（如 MCP 提供且为只读工具），或使用 `SearchSQL` 的 `START_US` / `END_US` 范围查询。仍需保留 `labels_code` 过滤并返回 `protocol_request_body`。

## 按号码和 trackid 查询

号码从 `protocol_request_uri` 中过滤，不要假定号码位于 `protocol_request_body` 或某个未确认的 URI 参数中。先通过 `StreamSchema` 或限定样例确认 URI 模板和号码归一化方式。当前环境已观察到 `/v1/vonr/subscription/users/861...`；若用户给出 11 位中国手机号，可在确认该前缀规则后补 `86`，所以优先使用完整 URI 精确匹配，并保留 `protocol_request_uri` 和 `trackid`：

```sql
SELECT _timestamp, labels_code, protocol_request_uri, protocol_request_body, trackid,
       <CONFIRMED_STATUS_FIELDS>
FROM vss_log
WHERE protocol_request_uri = '/v1/vonr/subscription/users/<NORMALIZED_PHONE_VALUE>'
  AND labels_code = '单用户业务签约同步'
ORDER BY <CONFIRMED_TIMESTAMP_FIELD> ASC
LIMIT SIZE
```

`<NORMALIZED_PHONE_VALUE>`、`<CONFIRMED_STATUS_FIELDS>` 和 `<CONFIRMED_TIMESTAMP_FIELD>` 不能原样发送；只有在样例/Schema 中确认后才能替换。号码需要按当前 SQL 方言正确转义，且查询仍必须带明确的开始/结束微秒时间范围。如果 URI 模板尚未确认，才使用下面的包含匹配作为临时候选查询：

```sql
SELECT _timestamp, labels_code, protocol_request_uri, protocol_request_body, trackid
FROM vss_log
WHERE protocol_request_uri LIKE '%<PHONE_VALUE>%'
  AND labels_code = '单用户业务签约同步'
ORDER BY <CONFIRMED_TIMESTAMP_FIELD> ASC
LIMIT SIZE
```

对每个实际得到的 `trackid`，在同一时间范围内查询并串联请求链路；不要再次用号码 `LIKE` 扫描：

```sql
SELECT _timestamp, labels_code, protocol_request_uri, protocol_request_body,
       protocol_response_code, code, protocol_code, trackid
FROM vss_log
WHERE trackid = '<CONFIRMED_TRACKID>'
ORDER BY <CONFIRMED_TIMESTAMP_FIELD> ASC
LIMIT SIZE
```

按链路排序后，从已确认的状态/结果字段判断最终签约结果；如果没有确认过状态语义，就报告“状态未确认”。当前项目允许按用户偏好完整输出号码；认证信息仍不得输出。
