#!/usr/bin/env node

import { readFileSync } from "node:fs";

const version = process.argv[2];
if (!version) {
  console.error("usage: node scripts/changelog-section.js <version>");
  process.exit(2);
}

const lines = readFileSync("CHANGELOG.md", "utf8").split(/\r?\n/);
const start = lines.indexOf(`## ${version}`);
const end = start < 0 ? -1 : lines.findIndex((line, index) => index > start && line.startsWith("## "));
const notes =
  start < 0
    ? ""
    : lines
        .slice(start + 1, end < 0 ? undefined : end)
        .join("\n")
        .trim();

if (!notes) {
  console.error(`stable release v${version} requires a non-empty CHANGELOG.md section`);
  process.exit(3);
}

process.stdout.write(`${notes}\n`);
