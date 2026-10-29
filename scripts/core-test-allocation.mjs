import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

export const WEIGHTS_SHA256 =
  "d72adb2e8e99450681540b74725701969007cfcc68c09c95e1862b8cb39bd813";
export const MAX_WEIGHT_BYTES = 256 * 1024;
const policy = "frozen-prior-whole-file-max-lpt-v1";
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const exactKeys = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join("|") === [...keys].sort().join("|");
const validWeight = (value) =>
  Number.isSafeInteger(value) && value > 0 && value <= 3_600_000_000;
const validFile = (value) =>
  typeof value === "string" &&
  value.length <= 256 &&
  /^tests\/[^/.][^/]*\.test\.mjs$/u.test(value) &&
  !/[\\\r\n*?\[\]{}()\x00-\x1f\x7f]/u.test(value);

export function parseWeights(bytes, expectedHash = WEIGHTS_SHA256) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_WEIGHT_BYTES)
    throw Error("Core weights exceed bounded JSON input");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== expectedHash) throw Error("Core weights digest mismatch");
  const data = JSON.parse(bytes.toString("utf8"));
  if (
    !exactKeys(data, [
      "version",
      "policy",
      "unit",
      "fallbackUs",
      "sources",
      "weights",
    ]) ||
    data.version !== 1 ||
    data.policy !== policy ||
    data.unit !== "microseconds" ||
    !validWeight(data.fallbackUs) ||
    !Array.isArray(data.sources) ||
    data.sources.length !== 24
  )
    throw Error("Malformed core weights metadata");
  const sources = new Set();
  for (const source of data.sources) {
    if (
      !exactKeys(source, ["runId", "headSha", "file", "sha256"]) ||
      ![40918700552, 40926521644].includes(source.runId) ||
      !/^[a-f0-9]{40}$/.test(source.headSha) ||
      !/^[a-f0-9]{64}$/.test(source.sha256) ||
      !/^core-(ubuntu|macos|windows)-latest-shard-[1-4]-of-4\.progress\.jsonl$/.test(
        source.file,
      )
    )
      throw Error("Malformed core weights provenance");
    const key = `${source.runId}/${source.file}`;
    if (sources.has(key)) throw Error("Duplicate core weights provenance");
    sources.add(key);
  }
  if (
    !data.weights ||
    typeof data.weights !== "object" ||
    Array.isArray(data.weights)
  )
    throw Error("Malformed core weights table");
  const entries = Object.entries(data.weights);
  if (
    !entries.length ||
    entries.length > 10000 ||
    entries.some(
      ([file, weight]) => !validFile(file) || !validWeight(weight),
    ) ||
    data.fallbackUs !== Math.max(...entries.map(([, weight]) => weight))
  )
    throw Error("Malformed core file weight or fallback");
  return { ...data, sha256 };
}

export async function loadWeights() {
  const handle = await open(
    new URL("./core-test-weights.json", import.meta.url),
    "r",
  );
  try {
    const buffer = Buffer.alloc(MAX_WEIGHT_BYTES + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        used,
        buffer.length - used,
        null,
      );
      if (!bytesRead) break;
      used += bytesRead;
    }
    return parseWeights(buffer.subarray(0, used));
  } finally {
    await handle.close();
  }
}

export function allocateWeighted(files, total, data) {
  if (
    !Number.isSafeInteger(total) ||
    total < 1 ||
    total > files.length ||
    new Set(files).size !== files.length ||
    files.some(
      (file) =>
        typeof file !== "string" ||
        !/^tests\/[^/.][^/]*\.test\.mjs$/u.test(file) ||
        /[\\\r\n*?\[\]{}()]/u.test(file),
    )
  )
    throw Error("Invalid weighted shard input");
  const weights = Object.fromEntries(
    files.map((file) => [
      file,
      Object.hasOwn(data.weights, file) ? data.weights[file] : data.fallbackUs,
    ]),
  );
  const shards = Array.from({ length: total }, () => []);
  const estimatedUs = Array(total).fill(0);
  for (const file of [...files].sort(
    (a, b) => weights[b] - weights[a] || compare(a, b),
  )) {
    let index = 0;
    for (let i = 1; i < total; i++)
      if (estimatedUs[i] < estimatedUs[index]) index = i;
    shards[index].push(file);
    estimatedUs[index] += weights[file];
    if (!Number.isSafeInteger(estimatedUs[index]))
      throw Error("Core estimate overflow");
  }
  for (const shard of shards) shard.sort(compare);
  return {
    shards,
    allocation: {
      policy: data.policy,
      weightsSha256: data.sha256,
      sources: data.sources,
      unit: data.unit,
      fallbackUs: data.fallbackUs,
      weights,
      fallbackFiles: files.filter((file) => !Object.hasOwn(data.weights, file)),
      estimatedUs,
    },
  };
}
