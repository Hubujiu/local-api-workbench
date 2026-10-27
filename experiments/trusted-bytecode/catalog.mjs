import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const ABI = "localapi-private-trusted-bytecode-v2";
export const UPSTREAM = "235f6da2fd4f7354fa4765fde4aea880d2a4aef5";
export const EMSDK = "3eb3e02dfd10eaa527ba61b89cfcfba13d1c060d";
export const FLAGS = Object.freeze({ compile: 32, write: 1, read: 1 });
export const LIMITS = Object.freeze({
  memory: 16 * 1024 * 1024,
  stack: 512 * 1024,
  activeMs: 250,
  wallMs: 2000,
});
export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

// These are application-owned inputs, not a parameterized bytecode compiler.
// Neither builder nor runtime takes a source/path/manifest/flags argument.
const entries = Object.freeze({
  schema: {
    path: "../../src/vendor/schema-library.js",
    sourceSha256:
      "64274e65d90ffe31110dfad16a771b4f20dcca269f36b56022dec243ce481d5f",
  },
  "schema-private": {
    path: "../../src/vendor/schema-library.js",
    sourceSha256:
      "64274e65d90ffe31110dfad16a771b4f20dcca269f36b56022dec243ce481d5f",
    wrapper: "private-schema-v1",
  },
  "library-prelude": {
    path: "./library-prelude.js",
    sourceSha256:
      "6bd3749ec4d0bf37d1b4aa3092035d7630f643219793f5720e6fa41a3a232eda",
  },
  libraries: {
    path: "../../src/vendor/script-libraries.js",
    sourceSha256:
      "05d269abaff3374cd7f15b6ec0f08520286134cf513bf37a9f06232c57747888",
  },
  fixture: {
    source:
      "globalThis.__trustedFixture = (globalThis.__trustedFixture || 0) + 1; ({owned: 'released return value'});",
  },
  callable: { source: "(function(value){ return value + 1; });" },
  throwing: { source: "throw new Error('fixed trusted fixture failure');" },
  allocating: {
    source:
      "globalThis.__trustedAllocation = new Array(4 * 1024 * 1024).fill(1);",
  },
  looping: { source: "while (true) {}" },
});
export const IDS = Object.freeze(Object.keys(entries));
export function fixedSource(id) {
  if (!Object.hasOwn(entries, id)) throw Error("Unknown fixed bundle");
  const entry = entries[id];
  const bytes = entry.path
    ? readFileSync(new URL(entry.path, import.meta.url))
    : Buffer.from(entry.source);
  const sourceSha256 = hash(bytes);
  if (entry.sourceSha256 && sourceSha256 !== entry.sourceSha256)
    throw Error("Fixed source identity mismatch");
  // Preserve the entire original IIFE byte-for-byte. Only the private-schema
  // variant adds a fixed outer lexical receiver; it never exports a guest-global
  // factory and does not rely on a guest-mutable Object.create or setter.
  const source =
    entry.wrapper === "private-schema-v1"
      ? "(function(globalThis){\n" +
        bytes.toString("utf8") +
        "\nreturn globalThis.__boundedJSONSchema;\n})({__proto__:null});"
      : bytes.toString("utf8");
  return {
    id,
    source,
    sourceSha256,
    wrapperSha256: hash(source),
    filename: `localapi:trusted/${id}.js`,
    flags: FLAGS,
  };
}
export function expectedEntry(id, bytecode) {
  const { source, ...identity } = fixedSource(id);
  return {
    ...identity,
    byteLength: bytecode.length,
    bytecodeSha256: hash(bytecode),
  };
}
