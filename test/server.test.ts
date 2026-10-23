import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { resolveInsideRoot, serveDirectory, type StaticServer } from "../src/server.ts";

test("resolveInsideRoot keeps paths inside the root", () => {
  const root = path.resolve("/srv/project");
  assert.equal(resolveInsideRoot(root, "/index.html"), path.join(root, "index.html"));
  assert.equal(resolveInsideRoot(root, "/a/../b.js"), path.join(root, "b.js"));
  assert.equal(resolveInsideRoot(root, "/../secret"), path.join(root, "secret"), "normalized against the URL root");
  assert.equal(resolveInsideRoot(root, "/%2e%2e/%2e%2e/etc/passwd"), path.join(root, "etc/passwd"));
  assert.equal(resolveInsideRoot(root, "/a%00b"), null);
  assert.equal(resolveInsideRoot(root, "/%E0%A4%A"), null, "malformed escapes are rejected");
});

let dir: string;
let server: StaticServer;
before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "framevelo-server-"));
  await mkdir(path.join(dir, "site", "nested"), { recursive: true });
  await writeFile(path.join(dir, "site", "index.html"), "<p>hi</p>");
  await writeFile(path.join(dir, "site", "nested", "app.js"), "export {}");
  await writeFile(path.join(dir, "outside.txt"), "secret");
  server = await serveDirectory(path.join(dir, "site"));
});
after(async () => {
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

test("serves files with content types and directory index", async () => {
  const page = await fetch(`${server.origin}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(await page.text(), "<p>hi</p>");
  const script = await fetch(`${server.origin}/nested/app.js`);
  assert.match(script.headers.get("content-type") ?? "", /javascript/);
  await script.arrayBuffer();
});

test("never serves files outside the root", async () => {
  for (const probe of ["/../outside.txt", "/%2e%2e/outside.txt", "/nested/../../outside.txt"]) {
    const res = await fetch(`${server.origin}${probe}`);
    assert.notEqual(await res.text(), "secret", probe);
  }
});

test("rejects other methods and missing files", async () => {
  assert.equal((await fetch(`${server.origin}/index.html`, { method: "POST" })).status, 405);
  assert.equal((await fetch(`${server.origin}/missing.js`)).status, 404);
});
