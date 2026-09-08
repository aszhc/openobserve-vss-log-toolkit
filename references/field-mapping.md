# `vss_log` 字段说明

## 核心字段

| 字段 | 含义 | 用法 |
| --- | --- | --- |
| `vss_log` | OpenObserve 中的 VSS 日志 Stream | 默认查询对象 |
| `labels_code` | 业务事件标签 | 用已确认的精确值过滤签约或退订日志 |
| `protocol_request_body` | 协议请求体，包含业务请求内容 | 从中解析业务 `appid`；查询时应保留该字段 |
| `op` | DC 请求动作 | 在 `protocol_request_body` 中解析：`ADD`=签约DC，`DELETE`=退订DC；其他值未确认 |
| `callEvent` | 呼叫事件载荷 | 位于 `protocol_request_body.callEvent`，包含事件、号码角色、方向、媒体和原因等字段 |
| `callEvent.event` | 通话生命周期事件 | 当前样例包括 `BEGIN`、`RINGING`、`ANSWER`、`MEDIA_UPDATE_REQUEST`、`RELEASE` |
| `callEvent.calling` / `called` / `redirecting` | 主叫、被叫、转接号码 | 呼叫事件按号码查询时从 body 解析，不从固定 `protocol_request_uri` 猜测 |
| `labels_caller` / `labels_callee` | 从呼叫事件提取的主叫、被叫字段 | Schema 确认有值时优先用于号码定位，再用 body 复核 |
| `labels_event` / `labels_direction` | 从呼叫事件提取的事件、方向字段 | 可用于缩小初始查询并与 `callEvent` 对照 |
| `callEvent.direction` | 呼叫方向 | 当前样例包括 `MO`、`MT`、`CF` |
| `callEvent.notificationMode` | 通知模式 | 当前样例包括 `NOTIFY`、`BLOCK` |
| `callEvent.bearerCapability` | 媒体能力 | 当前样例包括 `AUDIO`、`VIDEO`、`AUDIO&DC` |
| `callEvent.reason` | 释放/失败原因 | 在 `RELEASE` 等事件中可能包含 `protocol`、`cause`、`text` |
| `actions[].operation` | 通话过程中的控制操作 | 在 `呼叫事件控制接口` 中，`DC_CONTROL` 表示尝试触发 DC 能力 |
| `dcControl[].dcAction` | DC 控制动作 | `CREATE` 表示尝试创建/开通 DC 通道；需结合结果通知判断是否成功 |
| `actionResults[].operationResult` / `dcControlResult[].dcStatus` | DC 控制结果 | `SUCCESS` / `FAILURE` 是业务操作结果，不等同于接口传输层 `code` 或 HTTP 状态 |
| `callEvent.location` | 位置和无线小区信息 | 可能包含 `areaNumber`、`ncgi`/`ecgi`、`tac`；默认只做摘要并注意敏感性 |
| `protocol_request_uri` | 协议请求 URI，号码出现在其中 | 当前环境签约样例为 `/v1/vonr/subscription/users/861...`，DC 样例为 `/v1/vonr/subscription/dc-ability/861...`；确认事件模板后优先精确匹配完整 URI，查询时应保留该字段以便复核 |
| `appid` | 业务应用标识 | 通常从 `protocol_request_body` 提取；提取结果必须标注来源和解析状态 |
| `trackid` | 一次完整请求链路的关联 ID | 保留并用于串联同一条签约/退订请求链路 |
| `raw_message` | 原始日志文本 | 按 `trackid` 导出 `.trace` 时逐条写入；必须按 `_timestamp` 排序并分页取全 |

提取到 `appid` 后，按字符串查阅 [appid-catalog.md](appid-catalog.md) 映射业务名称。目录命中时同时报告 `appid` 和 `business_name`；未命中时标记为“未知业务（目录未收录）”。必须保留前导零，不能将 appid 当作数值处理。

字段名和字段类型以当前环境的 `StreamSchema` 为准。遇到未知字段、大小写差异或字段类型不确定时，先调用只读的 `StreamSchema`，不要凭经验补字段。

## `protocol_request_body` 解析规则

`protocol_request_body` 可能有两种表示：

1. 已经解析的 JSON 对象：直接在对象中查找 `appid`。
2. JSON 编码的字符串：先做一次 JSON 解析，再在得到的对象中查找 `appid`。

Agent 应兼容这两种形式；如果解析后仍是嵌套对象，应按实际结构继续定位，但不得猜测不存在的路径。字段可能以 `appid`、`appId` 或 `appIds` 出现；当前签约样例使用 `appIds` 数组。数组中的每个实际值都应保留，并说明来源路径。若存在多个候选 `appid`，保留候选值并说明路径或上下文，不能擅自选一个作为确定值。

部分通话样例带有字面量的 `\\n`、`\\t` 等转义控制符；解析前只解码必要的外层转义，再按 JSON 解析，避免把原始转义文本误判为非法 JSON。

建议查询返回至少包含：日志时间字段、`labels_code`、`protocol_request_body`，以及经 `StreamSchema` 或样例确认的成功/失败字段。结果量较大时可以先返回必要字段，再按需获取代表性完整日志。

## 成功与失败状态

当前工具包不预设某个成功/失败字段名称、枚举值或嵌套路径。不同环境可能使用不同字段，例如状态码、结果码、错误码或消息字段；这些只能以 `StreamSchema` 和实际样例确认。

查询“失败日志”时：

- 先检查 Schema，确认可用的状态字段和失败值；
- 若字段或失败值尚未确认，先说明不确定性，不要写出未经验证的过滤条件；
- 必要时先查询限定时间范围的样例，观察字段分布，再构造失败过滤；
- 若只能取得原始日志，按“状态未确认”统计，并保留错误信息摘要。

当前环境的一条签约样例同时出现 `code = SUCCESS`、`protocol_code = SUCCESS` 和 `protocol_response_code = 200`；这只是已观察到的样例，不应替代对目标时间范围的字段分布确认。

## 缺失与解析失败

按以下方式记录异常：

- `protocol_request_body` 缺失或为空：`appid` 标记为“未知（请求体缺失）”；
- 内容不是合法 JSON：标记为“未知（JSON 解析失败）”，不要把整段内容当作 `appid`；
- JSON 中没有 `appid`：标记为“未知（appid 缺失）”；
- 发现多个候选值：标记为“多个候选”，列出候选值和可确认的路径；
- 任何无法确认的结构：保留原始字段的安全摘要，并明确需要样例或 Schema。

不要在输出中展示认证信息，也不要为了提取 `appid` 调用写入、修改或删除类工具。

## `call_bill` 话单字段

`call_bill` 是与 `vss_log` 分开的呼叫话单 Stream。用户提供或 Agent 从呼叫事件解析出 `trackid` 后，使用 `call_bill.callidentifier = trackid` 精确关联；当前环境该字段有索引和 Bloom filter，优先等值查询。

| 字段 | 含义 | 用法 |
| --- | --- | --- |
| `callidentifier` | 话单关联键 | 与 `vss_log.trackid` 精确等值关联；按项目偏好可完整输出 |
| `calling` / `called` | 话单中的主叫、被叫 | 与 `callEvent.calling` / `called` 对照；按项目偏好完整输出 |
| `direction` | 话单呼叫方向 | 与 vss 的 `callEvent.direction` 对照 |
| `duration` | 话单/计费摘要时长 | 优先作为最终话单时长；不要当作单个协议操作耗时 |
| `time` | 话单记录时间 | 用于话单时间展示和窗口复核 |
| `bearercapability` | 话单承载能力 | 与 vss 的 `callEvent.bearerCapability` 对照 |
| `areacode` | 话单区域码 | 只在用户需要时摘要，避免暴露更细位置信息 |
| `details` | 呼叫过程/操作明细 JSON 数组 | Agent 侧解析 `name`、`event`、`protocolCode`、`cause`、`duration`、`sender`、`receiver`、`operation_0`、`result` 和时间戳 |

`call_bill.duration` 表示话单摘要时长；vss 侧的事件或协议 `duration` 可能只是接口处理耗时，两者语义不同。`details` 缺失、不是数组或 JSON 解析失败时，应保留话单主记录并单独报告明细不可用。当前项目允许按用户要求完整输出号码和关联键；`sender`、`receiver`、号码之外的内部标识仍按敏感信息处理。

## vss_log 与 call_bill 关联

完整通话查询应先在 `vss_log` 的 `呼叫事件通知接口` 中以有界时间范围获取 `trackid` 和 `callEvent` 生命周期，再在相同或略微扩展的时间范围内对 `call_bill` 做 `callidentifier = trackid` 精确查询。vss 侧用于还原 BEGIN/RINGING/ANSWER/MEDIA_UPDATE_REQUEST/RELEASE 链路和释放原因；call_bill 侧用于补充最终话单时长、话单时间、方向、双方、承载能力、区域码及操作结果。没有精确匹配的 `call_bill` 行时，标记为“未找到对应话单”，不能据此判定呼叫失败或补造时长。

## 按号码关联请求链路

号码过滤入口是 `protocol_request_uri`，而不是 `protocol_request_body`。按号码查询前，先用 `StreamSchema` 或限定样例确认该字段存在且为可搜索的 URI/字符串，并观察完整 URI 模板；不要臆造 URI 参数名。当前环境样例为 `/v1/vonr/subscription/users/861...`，因此在确认号码归一化规则后应优先使用完整 URI 的 `=` 精确匹配；若用户输入 11 位中国手机号且样例统一带 `86` 前缀，可在 Agent 侧构造 `86` 前缀候选（已带 `86` 的输入不重复添加）。仅在模板未知或存在额外路径/参数时，才退回 `LIKE '%号码%'` 等包含匹配。

对匹配的签约记录保留 `trackid`。同一个 `trackid` 表示一次完整请求链路；需要判断签约是否成功时，按已确认的时间字段排序该链路的相关记录，并依据已确认的状态/结果字段判断最终结果。若状态字段尚未确认，只能报告“状态未确认”，不能把最后一条日志简单当作成功。

当前项目偏好是不对号码和 `trackid` 脱敏，便于内部排障；含号码的完整 `protocol_request_uri` 也可在用户要求时展示。不得展示认证信息、IMEI、内网地址或不必要的完整请求体。

## 通话事件解析

`呼叫事件通知接口` 的 `protocol_request_uri` 当前通常固定为 `/v1/vss/sessions-followup/call-event`，号码不在 URI 中，而在 `protocol_request_body.callEvent` 的 `calling`、`called` 或 `redirecting`。按号码查询时需要在限定时间窗口内取候选日志后由 Agent 解析这些字段；不要把固定 URI 当作号码过滤条件。

`trackid` 与 `callEvent.callIdentifier` 在当前样例中通常可直接关联，但仍应对返回数据做校验。按关联键排序后，可计算 `BEGIN`→`ANSWER` 的接通时延、`BEGIN`→`RELEASE` 的观测时长，并汇总方向、媒体能力和 `reason.text`；缺少任一端点时标记为链路不完整。输出不得包含完整号码、IMEI、内网地址或 `callUrl`。
