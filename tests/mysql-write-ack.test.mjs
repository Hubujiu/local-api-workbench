import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
const execute = promisify(execFile);
for (const phase of ["commit", "rollback"])
  test(
    `real MySQL ${phase} ACK remains authoritative when the test process delays its continuation beyond the deadline`,
    { timeout: 12000 },
    async () => {
      const { stdout, stderr } = await execute(
        process.execPath,
        [
          fileURLToPath(
            new URL("./fixtures/mysql-write-ack-child.mjs", import.meta.url),
          ),
          phase,
        ],
        { timeout: 10000 },
      );
      assert.equal(stderr, "");
      assert.deepEqual(JSON.parse(stdout), {
        phase,
        observedACK: true,
        closed: true,
      });
    },
  );
