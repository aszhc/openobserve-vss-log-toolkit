# VSS 业务事件映射

本文档定义 VSS 日志中已确认的业务事件与 `labels_code` 的对应关系。查询默认使用 `vss_log` Stream。

## 已确认映射

| 业务事件 | 常见说法 | Stream | `labels_code` |
| --- | --- | --- | --- |
| 单用户业务签约同步 | 签约、签约日志、业务签约、单用户签约同步 | `vss_log` | `单用户业务签约同步` |
| 单用户业务退订信息同步 | 退订、退订日志、业务退订、单用户退订同步 | `vss_log` | `单用户业务退订信息同步` |
| 单用户新通话功能开通同步 | DC业务、签约DC、退订DC、DC开通 | `vss_log` | `单用户新通话功能开通同步` |
| 呼叫事件通知接口 | 通话开始、通话事件、呼叫生命周期 | `vss_log` | `呼叫事件通知接口` |
| 话单/计费摘要 | 话单、通话时长、计费结果、完整通话补充 | `call_bill` | 无 `labels_code`；使用 `callidentifier = vss_log.trackid` |

用户提到“签约的业务 appid”或“退订的业务 appid”时，先按上表选择事件过滤条件，再从返回记录的 `protocol_request_body` 提取 `appid`。对于 DC 业务，必须继续解析同一请求体的 `op`：`ADD` 是签约DC，`DELETE` 是退订DC。不要仅凭日志文本猜测事件类型。

## 单独查询

```sql
SELECT *
FROM vss_log
WHERE labels_code = '单用户业务签约同步'
```

```sql
SELECT *
FROM vss_log
WHERE labels_code = '单用户业务退订信息同步'
```

```sql
SELECT *
FROM vss_log
WHERE labels_code = '单用户新通话功能开通同步'
```

DC 查询返回后在 Agent 侧解析 `protocol_request_body.op`：`ADD` → 签约DC，`DELETE` → 退订DC；缺失、非法或其他值单独标记为“DC动作未确认”。

实际调用还必须添加有效的时间范围和分页参数，参见 [`query-patterns.md`](query-patterns.md)。

通话话单不是按 `labels_code` 查找。用户只提供号码时，先在 `call_bill` 按 `calling`/`called` 获取概况和 `callidentifier`，再回查 `vss_log`；用户提供 `trackid` 时直接用 `callidentifier = trackid` 精确关联，参见 [`field-mapping.md`](field-mapping.md) 和 [`query-patterns.md`](query-patterns.md)。

导出某通通话的 `.trace` 文件时也不按 `labels_code` 限制，因为需要保留同一 `trackid` 下所有业务类型的 `raw_message`。按 `_timestamp` 升序、分页取全，具体见 [`trace-export.md`](trace-export.md)。

## 合并查询

当用户要求同时查看签约和退订，或比较两类事件时，使用 `IN` 过滤：

```sql
SELECT *
FROM vss_log
WHERE labels_code IN (
  '单用户业务签约同步',
  '单用户业务退订信息同步'
)
```

返回后按 `labels_code` 区分事件，再按 `appid` 汇总。不要把两种事件混成一个总数。

## 映射边界

这里只记录已确认的四种映射。遇到其他 `labels_code`、相近但不同的业务名称，或用户要求新增业务映射时，必须先取得用户提供的映射或一条可核验的样例日志；在确认前不得臆造映射，也不得把未知事件归入签约、退订、DC 动作或通话生命周期。
