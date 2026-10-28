import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Each child observes a completed, real OS operation, then delivers the abort.
// This is not a replacement transaction or an abandoned Promise.race. Builtin
// binding changes stay in an isolated process and are restored in finally.
for (const operation of ["writeFile", "rename"]) {
  test(
    `cancellation immediately after real ${operation} completion obeys the atomic Cookie publication boundary`,
    { timeout: 8000 },
    async (t) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "cookie-publication-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const source = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs/promises';
      import {syncBuiltinESMExports} from 'node:module';
      import {setTimeout as sleep} from 'node:timers/promises';
      import {ProjectCookieJar} from ${JSON.stringify(new URL("../src/cookie-jar.mjs", import.meta.url).href)};
      const root = process.argv[1], operation = process.argv[2];
      const jar = new ProjectCookieJar(root, 'project', 'selected');
      const url = 'http://127.0.0.1/';
      await jar.configure({enabled: true, expectedRevision: 0});
      await jar.setCookie(url, 'seed=before; Path=/', {expectedRevision: 1});
      const before = await fs.readFile(jar.file);
      const original = fs[operation], controller = new AbortController();
      let observed = 0;
      fs[operation] = async function (...args) {
        const result = await Reflect.apply(original, this, args);
        if (typeof args[0] === 'string' && args[0].startsWith(jar.file + '.') && args[0].endsWith('.tmp')) {
          observed++;
          controller.abort();
        }
        return result;
      };
      syncBuiltinESMExports();
      try {
        await assert.rejects(jar.capture(url, ['changed=after; Path=/'], {signal: controller.signal}), {code: 'ABORT_ERR'});
      } finally {
        fs[operation] = original;
        syncBuiltinESMExports();
      }
      assert.equal(observed, 1);
      const committed = operation === 'rename';
      const expected = committed ? 'seed=before; changed=after' : 'seed=before';
      assert.equal(await new ProjectCookieJar(root, 'project', 'selected').header(url), expected);
      const after = await fs.readFile(jar.file);
      if (!committed) assert.deepEqual(after, before);
      assert.equal(JSON.parse(after).revision, committed ? 3 : 2);
      assert.deepEqual((await fs.readdir(jar.directory)).filter(name => /\\.(tmp|lock)$/.test(name)), []);
      await sleep(40);
      assert.deepEqual(await fs.readFile(jar.file), after);
      await jar.capture(url, ['healthy=next; Path=/']);
      assert.equal(await jar.header(url), expected + '; healthy=next');
      console.log(JSON.stringify({operation, observed, committed, revision: JSON.parse(after).revision, noLateWrites: true}));
    `;
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        ["--input-type=module", "-e", source, root, operation],
        { timeout: 6000, maxBuffer: 65536 },
      );
      assert.equal(stderr, "");
      assert.deepEqual(JSON.parse(stdout), {
        operation,
        observed: 1,
        committed: operation === "rename",
        revision: operation === "rename" ? 3 : 2,
        noLateWrites: true,
      });
    },
  );
}
