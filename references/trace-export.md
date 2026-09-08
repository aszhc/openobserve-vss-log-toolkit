# 通话原始日志 `.trace` 导出

## 目标

根据一个已确认的 `trackid`，从 `vss_log` 读取该链路的所有非空 `raw_message`，按 `_timestamp` 升序写入一个 UTF-8 文本文件。每条 `raw_message` 后至少保留一个换行，文件末尾也保留换行。

## 查询

查询必须使用该通话已知的有界时间范围。用户只提供号码时，先按话单优先流程取得 `callidentifier` 和通话时间，再令 `trackid = callidentifier`；可以在通话开始和结束时间两端各扩展一个小窗口，避免遗漏异步日志。

号码和目标时间已知时，首选端到端快速命令：

```bash
node scripts/fast-call-trace.mjs \
  --phone 8618368352203 \
  --at "2026-09-08 16:36" \
  --window-minutes 10 \
  --output-dir ./traces
```

正常单页场景只执行一次 `call_bill` 请求和一次 `vss_log` 请求。命令会用同一批 VSS 结果完成生命周期、appid、控制结果分析和 trace 写入，并只向 Agent 输出精简 JSON。不要在命令成功后重复查询这些字段。

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

使用 `SearchSQL` 的 `query.start_time`、`query.end_time`、`query.from` 和 `query.size` 分页。请求 `detail: "full"`，持续取页直到已获取全部结果；不要依赖 summary 模式的 100 条上限。合并分页结果后按 `_timestamp` 再排序一次。

## 文件名

格式：

```text
<DIRECTION>_<PHONE>_<CALL_START_YYYYMMDDHHMMSS>.trace
```

示例：

```text
MO_8615967308074_20260604201913.trace
```

字段来源：

- `DIRECTION`：优先使用 `call_bill.direction`，回退到 `labels_direction` 或 `callEvent.direction`；常见值为 `MO`、`MT`、`CF`。
- `PHONE`：用户明确提供目标号码时使用归一化后的目标号码；否则 `MO` 使用 `calling`，`MT` 使用 `called`。保留 `86` 国家码，仅去除空格、`+`、横线等非数字字符。
- `CALL_START`：优先使用 `callEvent.event=BEGIN` 的 `callEvent.timestamp`，按 `Asia/Shanghai` 转换；若没有 BEGIN，使用该 trackid 最早的 `_timestamp`；最后才回退到话单时间，并在结果中说明。

如果方向、号码或开始时间仍无法确认，不要编造文件名。报告缺少的元数据并请求用户提供，或让用户明确指定 `--direction`、`--phone`、`--start`。

## 写文件

快速命令不可用时，把完整查询结果保存成 JSON 数组、JSONL，或包含 `hits` 的 SearchSQL JSON，然后使用底层转换脚本：

```bash
node scripts/build-trace.mjs \
  --input /path/to/rows.json \
  --direction MO \
  --phone 8615967308074 \
  --start 2026-06-04T12:19:13.000Z \
  --output-dir /path/to/output
```

脚本默认拒绝覆盖已有同名文件；只有用户明确要求覆盖时才传 `--force`。成功后向用户返回文件绝对路径和写入的 `raw_message` 条数。

## 完整性与安全

- `raw_message` 缺失或为 `null` 的行不写入，并在摘要中报告缺失数量。
- 空字符串属于实际值，会作为一个空行写入。
- 不对号码和业务内容脱敏，这是当前项目偏好。
- 如果原始日志中包含 Authorization、Cookie、密码、token 或其他认证凭据，写文件前必须对凭据值做脱敏；该安全规则优先于“原样导出”。
- 不修改 OpenObserve 中的任何数据；本功能只在本地创建 `.trace` 文件。
