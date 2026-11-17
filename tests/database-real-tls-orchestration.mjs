// Linux CI setup-contract test with a recording Docker double, NOT real TLS acceptance.
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
const base = await mkdtemp(path.join(tmpdir(), "tls-orchestration-"));
const script = new URL("../scripts/ci/database-real-tls.sh", import.meta.url)
  .pathname;
const bin = path.join(base, "bin");
await mkdir(bin);
await writeFile(
  path.join(bin, "docker"),
  `#!/usr/bin/env node
const fs=require('node:fs');const a=process.argv.slice(2);fs.appendFileSync(process.env.DOCKER_RECORD,JSON.stringify(a)+'\\n');
const id=n=>n.toString(16).padStart(64,'0');
if(a[0]==='inspect'){console.log('sha256:'+id({pg:101,my:102,rd:103}[a.at(-1)]));}
else if(a[0]==='create'){let n=Number(fs.existsSync(process.env.DOCKER_COUNT)?fs.readFileSync(process.env.DOCKER_COUNT):0)+1;fs.writeFileSync(process.env.DOCKER_COUNT,String(n));console.log(id(n));}
else if(a[0]==='port') console.log('127.0.0.1:'+(18000+parseInt(a[1],16)));
else if(a[0]==='start' && process.env.FAIL_START==='1')process.exit(1);
else if(a[0]==='exec' && a.some(x=>x.includes('pg_hba_file_rules')||x.includes('@@GLOBAL.require_secure_transport')))console.log(process.env.FAIL_POLICY==='1'?'0':'1');
else if(a[0]==='exec' && a.includes('CONFIG'))console.log(a.at(-1)==='port'?'port\\n0':'tls-port\\n6379');
`,
  { mode: 0o700 },
);
try {
  for (const mode of ["success", "start", "policy"]) {
    const fail = mode !== "success";
    const runner = path.join(base, mode);
    await mkdir(runner);
    const root = path.join(runner, "localapi-real-tls"),
      record = path.join(runner, "calls.jsonl");
    const env = {
      ...process.env,
      PATH: bin + path.delimiter + process.env.PATH,
      RUNNER_TEMP: runner,
      LOCALAPI_TLS_ROOT: root,
      POSTGRES_SERVICE_ID: "pg",
      MYSQL_SERVICE_ID: "my",
      REDIS_SERVICE_ID: "rd",
      DOCKER_RECORD: record,
      DOCKER_COUNT: path.join(runner, "count"),
      FAIL_START: mode === "start" ? "1" : "0",
      FAIL_POLICY: mode === "policy" ? "1" : "0",
    };
    const setup = spawnSync("bash", [script, "setup"], {
      env,
      encoding: "utf8",
      timeout: 30000,
    });
    assert.equal(setup.status, fail ? 1 : 0, "bounded mock setup outcome");
    const calls = () =>
      readFile(record, "utf8").then((s) =>
        s.trim().split("\n").map(JSON.parse),
      );
    const before = await calls(),
      created = before.filter((a) => a[0] === "create");
    assert.equal(created.length, mode === "start" ? 1 : 6);
    for (const [index, a] of created.entries()) {
      const expectedImage =
        "sha256:" +
        (101 + Math.floor(index / 2)).toString(16).padStart(64, "0");
      assert.equal(a[a.indexOf("-ec") - 1], expectedImage);
      assert(a.includes("--pull=never"));
      assert.match(a[a.indexOf("-ec") - 1], /^sha256:[a-f0-9]{64}$/);
      assert.match(a[a.indexOf("-p") + 1], /^127\.0\.0\.1::(5432|3306|6379)$/);
      assert.match(
        a[a.indexOf("--mount") + 1],
        /source=.*\/(good|bad),target=\/fixture,readonly$/,
      );
    }
    assert(!before.some((a) => ["pull", "restart", "stop"].includes(a[0])));
    if (!fail) {
      const readiness = before.filter(
        (a) => a[0] === "exec" && a.includes("sh"),
      );
      assert.equal(readiness.length, 4);
      for (const a of readiness) {
        assert(["postgres", "mysql"].includes(a[a.indexOf("--user") + 1]));
        assert(a.at(-1).includes("readlink /proc/1/exe"));
      }
      const ports = JSON.parse(await readFile(path.join(root, "ports.json")));
      assert.equal(Object.keys(ports).length, 3);
      const policy = JSON.parse(
        await readFile(path.join(root, "server-policy.json")),
      );
      assert.deepEqual(policy.redis, { port: 0, tlsPort: 6379 });
      assert.equal(policy.postgres.hostnosslReject, true);
      assert.equal(policy.mysql.requireSecureTransport, true);
      for (const f of ["ca.key", "wrong-ca.key"])
        await assert.rejects(access(path.join(root, f)));
      for (const variant of ["good", "bad"]) {
        const cert = path.join(root, variant, "server.crt");
        const verify = (...extra) =>
          spawnSync(
            "openssl",
            ["verify", "-CAfile", path.join(root, "ca.crt"), ...extra, cert],
            { encoding: "utf8" },
          );
        assert.equal(verify().status, 0);
        assert.equal(
          verify("-verify_ip", "127.0.0.1").status,
          variant === "good" ? 0 : 2,
        );
      }
      const cleaned = spawnSync("bash", [script, "cleanup"], {
        env,
        encoding: "utf8",
        timeout: 10000,
      });
      assert.equal(cleaned.status, 0);
    }
    const removed = (await calls()).filter((a) => a[0] === "rm");
    assert.equal(removed.length, mode === "start" ? 1 : 6);
    assert(removed.every((a) => a[1] === "-fv" && /^[a-f0-9]{64}$/.test(a[2])));
    await assert.rejects(access(root));
  }
  console.log("TLS_ORCHESTRATION_MOCK_CONTRACT_PASS (not real services)");
} finally {
  await rm(base, { recursive: true, force: true });
}
