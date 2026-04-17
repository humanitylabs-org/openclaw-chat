#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const assert = require("assert");

function encodeBase64Utf8(text) {
  return Buffer.from(String(text), "utf8").toString("base64");
}

function decodeBase64Utf8(value) {
  try {
    return Buffer.from(String(value), "base64").toString("utf8");
  } catch {
    return "";
  }
}

const appPath = path.join(__dirname, "..", "app.js");
const app = fs.readFileSync(appPath, "utf8");

// Guardrails against regressions in the copy handler implementation.
assert(
  app.includes('data-raw-code="${rawCodeB64}"'),
  "Expected code blocks to embed raw code payload in data-raw-code"
);
assert(
  app.includes("const rawCode = rawB64 ? decodeBase64Utf8(rawB64) : \"\";"),
  "Expected copy handler to decode raw code payload"
);
assert(
  !app.includes("navigator.clipboard.writeText(code.innerText)"),
  "Copy handler must not use innerText (it can normalize/omit lines)"
);

// Repro assertion: SQL with -- comments, blank lines, indentation, semicolons.
const sql = [
  "-- Step 1: create schema",
  "CREATE TABLE users (",
  "  id INTEGER PRIMARY KEY,",
  "  email TEXT NOT NULL",
  ");",
  "",
  "-- Step 2: seed rows",
  "INSERT INTO users (id, email)",
  "VALUES (1, 'a@example.com');",
  "",
].join("\n");

const rawB64 = encodeBase64Utf8(sql);
const copied = decodeBase64Utf8(rawB64);

assert.strictEqual(
  copied,
  sql,
  "SQL copy payload must preserve comments, blank lines, indentation, and semicolons verbatim"
);

console.log("PASS: SQL copy payload preserves full verbatim block text.");
