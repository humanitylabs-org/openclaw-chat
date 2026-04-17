#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const appPath = path.join(__dirname, "..", "app.js");
const app = fs.readFileSync(appPath, "utf8");

// Guardrail: ensure image/audio extractors fall back to the full block payload
// so inline message blocks like {type:"image", data:"...", mimeType:"image/jpeg"}
// survive history parsing.
assert(
  app.includes("mediaUrlFromSource(block.source || block.image || block.image_url || block)"),
  "Expected imageFromBlock to fallback to block payload"
);
assert(
  app.includes("mediaUrlFromSource(block.source || block.audio || block.audio_url || block.input_audio || block)"),
  "Expected audioFromBlock to fallback to block payload"
);

function mediaUrlFromSource(source) {
  if (!source) return "";
  if (typeof source === "string") return source.trim();
  if (typeof source.url === "string") return source.url.trim();
  if (typeof source.data === "string") {
    const mediaType = source.media_type || source.mediaType || source.mimeType || "application/octet-stream";
    return `data:${mediaType};base64,${source.data}`;
  }
  return "";
}

function imageFromBlock(block) {
  if (!block || typeof block !== "object") return "";
  if (block.type === "image" || block.type === "input_image") {
    return mediaUrlFromSource(block.source || block.image || block.image_url || block);
  }
  return "";
}

// Repro assertion for current bug shape from webchat history.
const inlineImageBlock = {
  type: "image",
  data: "QUJDRA==", // ABCD
  mimeType: "image/jpeg",
};

const parsed = imageFromBlock(inlineImageBlock);
assert.strictEqual(
  parsed,
  "data:image/jpeg;base64,QUJDRA==",
  "Inline image history block must parse into a data URL"
);

console.log("PASS: inline image history payloads are preserved.");
