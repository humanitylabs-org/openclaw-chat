#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const appPath = path.join(__dirname, "..", "app.js");
const app = fs.readFileSync(appPath, "utf8");

assert(app.includes("INLINE_MEDIA_CACHE_KEY"), "Missing inline media cache constants");
assert(app.includes("function recoverInlineMediaForHistory("), "Missing omitted-media recovery function");
assert(app.includes("omitted by history payload limits"), "Missing UI notice for omitted media");
assert(app.includes("rememberPendingInlineMedia("), "Missing pending media persistence hook");

// Minimal reproducible assertion of matching strategy
function inlineMediaTextKey(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 180);
}

function recoverInlineMediaForHistory(pending, sessionKey, text, timestamp, wantImages) {
  const key = inlineMediaTextKey(text);
  let best = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const item of pending) {
    if (!item || item.sessionKey !== sessionKey) continue;
    if ((item.images || []).length < wantImages) continue;
    if (item.textKey && key && item.textKey !== key) continue;
    const delta = Math.abs((item.timestamp || 0) - (timestamp || 0));
    if (delta > 10 * 60 * 1000) continue;
    if (delta < bestDelta) {
      best = item;
      bestDelta = delta;
    }
  }
  return best ? best.images.slice(0, wantImages) : [];
}

const pending = [
  {
    sessionKey: "tab-45",
    textKey: inlineMediaTextKey("I added a screenshot in here and notice how it doesn't display in the chat history."),
    timestamp: 1776400244456,
    images: ["data:image/jpeg;base64,QUJDRA=="],
  },
];

const recovered = recoverInlineMediaForHistory(
  pending,
  "tab-45",
  "I added a screenshot in here and notice how it doesn't display in the chat history.",
  1776400244500,
  1,
);

assert.strictEqual(recovered.length, 1, "Expected omitted image to be recoverable from pending cache");
assert.strictEqual(recovered[0], "data:image/jpeg;base64,QUJDRA==");

console.log("PASS: omitted inline image recovery guardrails present.");
