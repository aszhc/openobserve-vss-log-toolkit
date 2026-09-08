#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function usage() {
  return [
    "Usage:",
    "  node scripts/build-trace.mjs --input <rows.json|rows.jsonl> --direction <MO|MT|CF> --phone <number> --start <ISO|yyyyMMddHHmmss> [--output-dir <dir>] [--force]",
    "",
    "The input may be a JSON array, an object with hits, an MCP/SearchSQL response, or JSONL rows.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { outputDir: process.cwd(), force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--force") {
      options.force = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`Unknown argument: ${arg}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }
    i += 1;
    const key = {
      "--input": "input",
      "--direction": "direction",
      "--phone": "phone",
      "--start": "start",
      "--output-dir": "outputDir",
    }[arg];
    if (!key) throw new Error(`Unknown option: ${arg}`);
    options[key] = value;
  }
  for (const key of ["input", "direction", "phone", "start"]) {
    if (!options[key]) throw new Error(`Missing required option: ${key}`);
  }
  return options;
}

function parseJsonText(text) {
  try {
    return JSON.parse(text);
  } catch {
    const rows = text
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "")
      .map((line, index) => {
        try {
          return JSON.parse(line);
        } catch (error) {
          throw new Error(`Invalid JSONL at line ${index + 1}: ${error.message}`);
        }
      });
    return rows;
  }
}

function parseContentText(content) {
  if (!Array.isArray(content)) return null;
  for (const item of content) {
    if (item?.type !== "text" || typeof item.text !== "string") continue;
    try {
      const parsed = JSON.parse(item.text);
      const rows = extractRows(parsed);
      if (rows) return rows;
    } catch {
      // Ignore non-JSON text blocks and keep looking.
    }
  }
  return null;
}

export function extractRows(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value.hits)) return value.hits;
  if (Array.isArray(value.structuredContent?.hits)) return value.structuredContent.hits;
  if (Array.isArray(value.result?.structuredContent?.hits)) {
    return value.result.structuredContent.hits;
  }
  return parseContentText(value.content) ?? parseContentText(value.result?.content);
}

export function readRows(inputPath) {
  const parsed = parseJsonText(fs.readFileSync(inputPath, "utf8"));
  const rows = extractRows(parsed);
  if (!rows) throw new Error("Input does not contain a supported row or hits array");
  return rows;
}

export function formatStart(value) {
  if (/^\d{14}$/.test(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("--start must be an ISO timestamp or yyyyMMddHHmmss");
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return ["year", "month", "day", "hour", "minute", "second"].map(get).join("");
}

export function makeFilename({ direction, phone, start }) {
  const safeDirection = direction.toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  const safePhone = phone.replace(/\D/g, "");
  if (!safeDirection) throw new Error("Direction is empty after filename sanitization");
  if (!safePhone) throw new Error("Phone is empty after filename sanitization");
  return `${safeDirection}_${safePhone}_${formatStart(start)}.trace`;
}

export function redactCredentialValues(message) {
  let value = String(message);
  let count = 0;
  const replace = (pattern, replacer) => {
    value = value.replace(pattern, (...args) => {
      count += 1;
      return replacer(...args);
    });
  };

  const keys = "authorization|proxy-authorization|cookie|set-cookie|password|passwd|token|access_token|refresh_token|api[_-]?key|x-api-key";
  replace(
    new RegExp(`(["']?(?:${keys})["']?\\s*[:=]\\s*)(["'])(.*?)\\2`, "gi"),
    (_match, prefix, quote) => `${prefix}${quote}<redacted>${quote}`,
  );
  replace(
    new RegExp(`^(\\s*(?:${keys})\\s*:\\s*)(.*)$`, "gim"),
    (_match, prefix) => `${prefix}<redacted>`,
  );
  replace(
    new RegExp(`(\\b(?:${keys})\\b\\s*=\\s*)([^&\\s,;}]+)`, "gi"),
    (_match, prefix) => `${prefix}<redacted>`,
  );
  return { value, count };
}

export function renderTrace(rows) {
  const ordered = rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const a = Number(left.row?._timestamp);
      const b = Number(right.row?._timestamp);
      if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return a - b;
      return left.index - right.index;
    });

  const messages = ordered
    .filter(({ row }) => row && row.raw_message !== null && row.raw_message !== undefined)
    .map(({ row }) => String(row.raw_message));

  if (messages.length === 0) throw new Error("No raw_message values found in input rows");
  let credentialRedactions = 0;
  const safeMessages = messages.map((message) => {
    const redacted = redactCredentialValues(message);
    credentialRedactions += redacted.count;
    return redacted.value;
  });
  return {
    content: safeMessages.map((message) => (message.endsWith("\n") ? message : `${message}\n`)).join(""),
    inputRows: ordered.length,
    count: messages.length,
    skippedNull: ordered.length - messages.length,
    credentialRedactions,
  };
}

export function writeTrace(options) {
  const rows = readRows(options.input);
  return writeTraceRows(rows, options);
}

export function writeTraceRows(rows, options) {
  const rendered = renderTrace(rows);
  const filename = makeFilename(options);
  const outputPath = path.resolve(options.outputDir, filename);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, rendered.content, {
    encoding: "utf8",
    flag: options.force ? "w" : "wx",
  });
  return {
    outputPath,
    filename,
    inputRows: rendered.inputRows,
    recordsWritten: rendered.count,
    skippedNull: rendered.skippedNull,
    credentialRedactions: rendered.credentialRedactions,
  };
}

function main() {
  try {
    const result = writeTrace(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
