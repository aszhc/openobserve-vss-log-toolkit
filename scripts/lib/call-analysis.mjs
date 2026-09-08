import fs from "node:fs";

function normalizeOffset(value) {
  return String(value).replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
}

function timestampMs(row) {
  if (row?.time) {
    const parsed = Date.parse(normalizeOffset(row.time));
    if (Number.isFinite(parsed)) return parsed;
  }
  const micros = Number(row?._timestamp);
  return Number.isFinite(micros) ? micros / 1000 : NaN;
}

function roundSeconds(milliseconds) {
  return Math.round(milliseconds / 10) / 100;
}

function addUnique(array, value) {
  if (value !== undefined && value !== null && value !== "" && !array.includes(value)) {
    array.push(value);
  }
}

function addAppids(array, value) {
  if (value === undefined || value === null) return;
  for (const appid of String(value).split(/[,，]/).map((item) => item.trim()).filter(Boolean)) {
    addUnique(array, appid);
  }
}

export function parseTargetTime(value) {
  const text = String(value).trim();
  const local = text.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2})(\.\d{1,3})?)?$/);
  const normalized = local
    ? `${local[1]}T${local[2]}:${local[3] ?? "00"}${local[4] ?? ""}+08:00`
    : normalizeOffset(text);
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds)) {
    throw new Error("--at must be an ISO timestamp or local yyyy-MM-dd HH:mm[:ss] time");
  }
  return milliseconds;
}

export function makeWindow(targetMs, windowMinutes) {
  if (!Number.isFinite(targetMs)) throw new Error("target time is invalid");
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) {
    throw new Error("windowMinutes must be positive");
  }
  const radius = windowMinutes * 60 * 1000;
  return {
    startUs: Math.trunc((targetMs - radius) * 1000),
    endUs: Math.trunc((targetMs + radius) * 1000),
  };
}

export function selectNearestBill(rows, targetMs) {
  const candidates = rows
    .filter((row) => typeof row?.callidentifier === "string" && row.callidentifier)
    .map((row) => ({ row, milliseconds: timestampMs(row) }))
    .filter((candidate) => Number.isFinite(candidate.milliseconds))
    .map((candidate) => ({
      ...candidate,
      distance: Math.abs(candidate.milliseconds - targetMs),
    }))
    .sort((left, right) => left.distance - right.distance || left.milliseconds - right.milliseconds);
  if (candidates.length === 0) throw new Error("No call bill with a usable callidentifier and timestamp was found");

  const nearestDistance = candidates[0].distance;
  const tied = candidates.filter((candidate) => candidate.distance === nearestDistance);
  const identifiers = [...new Set(tied.map((candidate) => candidate.row.callidentifier))];
  if (identifiers.length > 1) {
    const details = tied
      .map((candidate) => `${candidate.row.callidentifier}@${new Date(candidate.milliseconds).toISOString()}`)
      .join(", ");
    throw new Error(`Multiple equidistant call bills require selection: ${details}`);
  }
  return candidates[0].row;
}

export function parseJsonValue(value) {
  let current = value;
  for (let depth = 0; depth < 3; depth += 1) {
    if (current && typeof current === "object") return current;
    if (typeof current !== "string") return null;
    try {
      current = JSON.parse(current);
    } catch {
      return null;
    }
  }
  return current && typeof current === "object" ? current : null;
}

export function loadAppCatalog(markdownPath) {
  const catalog = new Map();
  const text = fs.readFileSync(markdownPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\|\s*([^|]+?)\s*\|\s*`(\d+)`\s*\|$/);
    if (match && match[1] !== "business_name") catalog.set(match[2], match[1].trim());
  }
  return catalog;
}

function collectBodyAppids(value, output = []) {
  if (!value || typeof value !== "object") return output;
  for (const [key, item] of Object.entries(value)) {
    if (["appid", "appId"].includes(key) && (typeof item === "string" || typeof item === "number")) {
      addAppids(output, item);
    } else if (key === "appIds" && Array.isArray(item)) {
      for (const appid of item) addAppids(output, appid);
    } else if (item && typeof item === "object") {
      collectBodyAppids(item, output);
    }
  }
  return output;
}

function eventPayload(row) {
  const body = parseJsonValue(row.protocol_request_body);
  return body?.callEvent ?? body?.call_event ?? body;
}

function eventTime(payload, row) {
  const raw = payload?.timestamp ?? payload?.eventTime ?? payload?.time;
  const parsed = raw ? Date.parse(normalizeOffset(raw)) : NaN;
  if (Number.isFinite(parsed)) return parsed;
  return timestampMs(row);
}

function rowAppids(row) {
  const appids = [];
  addAppids(appids, row.labels_appid);
  addAppids(appids, row.protocol_labels_appid);
  collectBodyAppids(parseJsonValue(row.protocol_request_body), appids);
  return appids.filter(Boolean).map(String);
}

export function summarizeCall({ bill, rows, appCatalog = new Map() }) {
  const lifecycle = [];
  for (const row of rows) {
    if (row.labels_code !== "呼叫事件通知接口") continue;
    const payload = eventPayload(row);
    const name = payload?.event ?? row.labels_event;
    const milliseconds = eventTime(payload, row);
    if (!name || !Number.isFinite(milliseconds)) continue;
    lifecycle.push({
      event: name,
      timestamp: new Date(milliseconds).toISOString(),
      milliseconds,
      notificationMode: payload?.notificationMode,
    });
  }
  lifecycle.sort((left, right) => left.milliseconds - right.milliseconds);

  const firstEvent = (name) => lifecycle.find((item) => item.event === name);
  const begin = firstEvent("BEGIN");
  const ringing = firstEvent("RINGING");
  const answer = firstEvent("ANSWER");
  const release = firstEvent("RELEASE");
  const releaseRow = release
    ? rows.find((row) => row.labels_code === "呼叫事件通知接口" && (eventPayload(row)?.event ?? row.labels_event) === "RELEASE")
    : null;
  const releaseReason = releaseRow ? eventPayload(releaseRow)?.reason : undefined;

  const businesses = new Map();
  const ensureBusiness = (appid) => {
    if (!businesses.has(appid)) {
      businesses.set(appid, {
        appid,
        businessName: appCatalog.get(appid) ?? "未知业务（目录未收录）",
        notifiedEvents: [],
        operations: [],
        operationResults: [],
      });
    }
    return businesses.get(appid);
  };

  for (const row of rows) {
    for (const appid of rowAppids(row)) {
      const business = ensureBusiness(appid);
      if (row.labels_code === "呼叫事件通知") addUnique(business.notifiedEvents, row.labels_event);
      for (const operation of [row.labels_operation_0, row.labels_operation_1]) {
        addUnique(business.operations, operation);
      }
      for (const result of [row.labels_operationresult_0, row.labels_operationresult_1]) {
        addUnique(business.operationResults, result);
      }
    }
  }

  return {
    trackid: bill.callidentifier,
    calling: bill.calling,
    called: bill.called,
    direction: bill.direction,
    bearerCapability: bill.bearercapability,
    billedDurationSeconds: Number(bill.duration),
    billTime: bill.time,
    answered: Boolean(answer),
    released: Boolean(release),
    beginTime: begin?.timestamp,
    ringingTime: ringing?.timestamp,
    answerTime: answer?.timestamp,
    releaseTime: release?.timestamp,
    setupSeconds: begin && answer ? roundSeconds(answer.milliseconds - begin.milliseconds) : undefined,
    connectedSeconds: answer && release ? roundSeconds(release.milliseconds - answer.milliseconds) : undefined,
    observedSeconds: begin && release ? roundSeconds(release.milliseconds - begin.milliseconds) : undefined,
    releaseReason,
    lifecycle: lifecycle.map(({ milliseconds: _milliseconds, ...item }) => item),
    businesses: [...businesses.values()],
    totalRows: rows.length,
    rawMessages: rows.filter((row) => row.raw_message !== null && row.raw_message !== undefined).length,
  };
}
