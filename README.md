# openobserve-vss-log-toolkit

一个面向多个 AI Agent 的客户端无关工具包，用于通过 OpenObserve MCP 只读查询和分析 VSS 日志。它把连接配置与业务查询规则分开：MCP 负责执行查询，`SKILL.md` 负责指导 Agent 选择事件、提取 `appid` 和整理结果。

## 包含内容

- `SKILL.md`：触发条件、签约/退订映射、只读查询流程、安全边界和输出契约。
- `mcp.json.template`：使用环境变量的 HTTP MCP 配置模板。
- `references/`：业务事件、字段、appid 业务目录、SQL 模板和结果格式的渐进式参考资料。
- `scripts/build-trace.mjs`：把按 trackid 查询得到的 `raw_message` 按时间排序并写成 `.trace` 文件。
- `scripts/fast-call-trace.mjs`：输入号码和时间，以一次话单查询和一次链路查询完成通话分析及 `.trace` 导出。

## 配置环境变量

在导入 MCP 配置的 Agent 环境中设置：

```text
OPENOBSERVE_MCP_URL: complete MCP endpoint, including /api/<org_id>/mcp
OPENOBSERVE_AUTH: Base64(username:password), without the "Basic " prefix
OPENOBSERVE_ORG_ID: organization ID passed to SearchSQL, StreamList, and StreamSchema
```

例如（请替换为你自己的环境值，不要把真实凭据写入仓库）：

```bash
export OPENOBSERVE_MCP_URL="http://host:port/api/<org_id>/mcp"
export OPENOBSERVE_AUTH="<base64 username:password>"
export OPENOBSERVE_ORG_ID="<org_id>"
```

`mcp.json.template` 中的 `url` 和 `Authorization` 都是变量引用；模板不包含真实主机、组织、用户名、密码或 Base64 token。将认证信息保存在 Agent 的环境或秘密管理器中，并把凭据文件排除在版本控制之外。

## 在不同 Agent 中使用

1. 将 `mcp.json.template` 中的 `mcpServers.openobserve` 对象导入 Agent 自己的 MCP 配置格式；不同 Agent 的字段名或环境变量展开方式可能不同，按该 Agent 文档转换。
2. 将 `SKILL.md` 加载到 Agent 自己的 skills/rules 机制中，或在项目级规则中引用它。
3. 确认 Agent 能看到 OpenObserve 的 `SearchSQL`、`StreamSchema` 和 `StreamList` 只读工具。
4. 保持 `OPENOBSERVE_MCP_URL`、`OPENOBSERVE_AUTH` 和 `OPENOBSERVE_ORG_ID` 在工具包之外，以便切换环境并避免泄漏凭据。

## 已支持的业务

- 签约：`labels_code = '单用户业务签约同步'`
- 退订：`labels_code = '单用户业务退订信息同步'`
- DC 业务：`labels_code = '单用户新通话功能开通同步'`；`protocol_request_body.op=ADD` 为签约DC，`op=DELETE` 为退订DC；当前 URI 样例为 `/v1/vonr/subscription/dc-ability/861...`
- 通话事件：`labels_code = '呼叫事件通知接口'`；解析 `protocol_request_body.callEvent`，用 `BEGIN/RINGING/ANSWER/RELEASE` 还原生命周期
- 通话号码定位：若 Schema 中存在并有值，优先用 `labels_caller` / `labels_callee`，再用请求体复核；固定回调 URI 通常不携带号码
- 话单优先：按号码先查 `call_bill` 的 `calling/called` 获取概况和 `callidentifier`，再用 `callidentifier = trackid` 精确回查 `vss_log`；读取 `duration`、`time`、方向、双方、承载能力和 `details` 操作明细
- 号码过滤：从 `protocol_request_uri` 中过滤；确认 `/v1/vonr/subscription/users/<号码>` 模板后优先使用完整 URI 精确匹配，模板未知时才使用子串匹配
- 业务 `appid`：从 `protocol_request_body`（JSON 对象或 JSON 字符串）中提取，兼容 `appid`、`appId` 和 `appIds` 数组
- 业务名称：按字符串从 `references/appid-catalog.md` 反向映射；保留前导零，未收录值标记为“未知业务（目录未收录）”
- 请求链路：`trackid` 表示一次完整请求链路；按号码查询时先确认 `protocol_request_uri`/时间字段，再按 `trackid` 串联日志并判断最终状态
- 原始日志导出：按 `trackid` 查询 `vss_log._timestamp/raw_message`，分页取全后生成 `<方向>_<号码>_<开始时间>.trace`

工具包第一版只允许日志查询和分析，不执行日志写入或 OpenObserve 管理操作。

当前项目偏好：号码和 `trackid` 不做脱敏，便于内部排障；认证 token、IMEI、内网地址和 `callUrl` 仍不输出。

## 示例提示词

```text
查询昨天单用户业务签约同步失败的业务 appid，并统计每个 appid 的失败次数。
```

```text
查询最近两小时的单用户业务退订信息同步日志，列出最近一次发生时间。
```

```text
对比今天签约和退订日志中的业务 appid，找出只签约未退订的 appid。
```

```text
查询号码 13800138000 什么时候签约了什么业务，以及签约是否成功。
```

```text
查询最近一天 DC 业务的签约和退订数量，并列出无法识别的 op。
```

```text
分析最近一小时通话开始、接通、释放情况，并按通话链路统计接通时延和释放原因。
```

```text
根据 trackid 查询完整通话日志，并结合 call_bill 给出通话时长、方向、通话双方和呼叫结果。
```

```text
根据这个 trackid 获取完整通话原始日志，把所有 raw_message 按时间顺序导出为 trace 文件。
```

脚本用法：

```bash
node scripts/fast-call-trace.mjs \
  --phone 8618368352203 \
  --at "2026-09-08 16:36" \
  --window-minutes 10 \
  --output-dir ./traces
```

快速命令从项目级 `.mcp.json` 读取连接，在普通单页结果下只发出两次网络请求，并输出不含原始日志和认证信息的 JSON 摘要。底层离线转换脚本用法：

```bash
node scripts/build-trace.mjs \
  --input /path/to/rows.json \
  --direction MO \
  --phone 8615967308074 \
  --start 2026-06-04T12:19:13.000Z \
  --output-dir /path/to/output
```

示例输出文件名：`MO_8615967308074_20260604201913.trace`。脚本默认不覆盖同名文件；只有用户明确要求时才使用 `--force`。

## 安全提示

不要提交包含真实 `OPENOBSERVE_AUTH` 值的文件，也不要在回答、日志或截图中展示 Authorization token。账号应尽量使用只读、最小权限的专用凭据。
