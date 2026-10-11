import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");

test("node-html-parser LICENSE ships with the packaged app", () => {
  const license = readFileSync(join(desktop, "licenses/node-html-parser/LICENSE"), "utf8");
  const listing = readFileSync(join(desktop, "licenses/THIRD-PARTY-NOTICES.txt"), "utf8");
  const builder = readFileSync(join(desktop, "electron-builder.yml"), "utf8");

  assert.match(license, /Permission is hereby granted, free of charge/);
  assert.match(license, /Copyright 2019 Tao Qiufeng/);
  assert.match(listing, /node-html-parser 9\.0\.4/);
  assert.match(listing, /License: MIT/);
  assert.match(listing, /licenses\/node-html-parser\/LICENSE/);
  assert.match(builder, /extraResources:/);
  assert.match(builder, /from: licenses/);
  assert.match(builder, /to: licenses/);
});
