import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const EXT = path.join(ROOT, "extension");
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));

test("manifest is store-ready: icons, popup, minimal permissions", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.action.default_popup, "popup.html");
  assert.equal(manifest.host_permissions, undefined);
  assert.deepEqual(new Set(manifest.permissions), new Set(["tabs", "debugger", "tabGroups", "storage", "alarms"]));
  for (const file of ["popup.html", "popup.js", "popup.css", "background.js", "options.html"]) {
    assert.ok(fs.existsSync(path.join(EXT, file)), `missing ${file}`);
  }
});

test("all manifest icons exist and are PNG files", () => {
  for (const file of Object.values(manifest.icons)) {
    const target = path.join(EXT, file);
    assert.ok(fs.existsSync(target), `missing ${file}`);
    const header = fs.readFileSync(target).subarray(0, 8);
    assert.equal(header.toString("hex"), "89504e470d0a1a0a", `${file} is not a PNG`);
  }
});

test("popup uses external scripts and styles only", () => {
  const html = fs.readFileSync(path.join(EXT, "popup.html"), "utf8");
  assert.match(html, /<script src="popup\.js"/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i);
  assert.match(html, /<link rel="stylesheet" href="popup\.css"/);
});

test("privacy policy is present for the store listing", () => {
  assert.ok(fs.existsSync(path.join(ROOT, "PRIVACY.md")));
});
