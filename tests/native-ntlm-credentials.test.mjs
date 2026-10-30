import test from "node:test";
import assert from "node:assert/strict";
import {
  importApipostNtlm,
  exportApipostNtlm,
} from "../src/apipost-ntlm-auth.mjs";
import { importExtendedApipostAuth } from "../src/apipost-auth-import.mjs";
import { exportExtendedApipostAuth } from "../src/apipost-auth-export.mjs";
const secret = "FICTIONAL_NTLM_PRIVATE_VALUE";
const native = () => ({
  username: "User",
  password: secret,
  domain: "Domain",
  workstation: "COMPUTER",
  disableRetryRequest: false,
});
const canonical = () => ({
  type: "ntlm",
  username: "User",
  password: secret,
  domain: "Domain",
  workstation: "COMPUTER",
});
function rejected(fn) {
  assert.throws(fn, (error) => {
    assert(error instanceof Error);
    assert.match(
      error.message,
      /^原生NTLM认证 (definition|size|username|password|domain|workstation|identity|disableRetryRequest|type) (无法安全规范映射；请使用项目备份|无效)$/,
    );
    assert(!String(error).includes(secret));
    assert(!Object.hasOwn(error, "cause"));
    return true;
  });
}
test("native NTLM canonical four-field identity roundtrips without mutation", () => {
  const input = native(),
    before = structuredClone(input),
    expected = canonical();
  assert.deepEqual(importApipostNtlm(input), expected);
  assert.deepEqual(exportApipostNtlm(expected), { type: "ntlm", ntlm: input });
  assert.deepEqual(
    importApipostNtlm(exportApipostNtlm(expected).ntlm),
    expected,
  );
  assert.deepEqual(input, before);
  const minimal = importApipostNtlm({ username: "User" });
  assert.deepEqual(minimal, {
    type: "ntlm",
    username: "User",
    password: "",
    domain: "",
    workstation: "",
  });
  assert.deepEqual(exportApipostNtlm({ type: "ntlm", username: "User" }), {
    type: "ntlm",
    ntlm: {
      username: "User",
      password: "",
      domain: "",
      workstation: "",
      disableRetryRequest: false,
    },
  });
  const nullProto = Object.assign(Object.create(null), native());
  assert.deepEqual(importApipostNtlm(nullProto), expected);
});
test("native NTLM preserves credential templates only where identity fallback is unambiguous", () => {
  for (const username of [
    "{{user}}",
    "Domain\\User",
    "user@domain",
    "{{user}}@domain",
  ]) {
    const source = {
      ...native(),
      username,
      password: "{{password}}",
      workstation: "{{workstation}}",
    };
    const result = importApipostNtlm(source);
    assert.equal(result.username, username);
    assert.equal(result.password, "{{password}}");
    assert.equal(result.workstation, "{{workstation}}");
    assert.deepEqual(exportApipostNtlm(result).ntlm, source);
    for (const domain of ["", "{{domain}}", "prefix{{domain}}"]) {
      rejected(() => importApipostNtlm({ ...source, domain }));
      rejected(() => exportApipostNtlm({ ...result, domain }));
    }
  }
  const safe = { ...native(), username: "User", domain: "{{domain}}" };
  assert.deepEqual(exportApipostNtlm(importApipostNtlm(safe)).ntlm, safe);
});
test("native NTLM rejects disabled, legacy, dynamic and malformed retry switches", () => {
  for (const disableRetryRequest of [
    true,
    0,
    1,
    "false",
    "true",
    "{{retry}}",
    null,
    undefined,
    {},
    [],
  ])
    rejected(() => importApipostNtlm({ ...native(), disableRetryRequest }));
  for (const value of [
    { ...canonical(), disableRetryRequest: false },
    { ...canonical(), entity: "" },
    { ...canonical(), extra: secret },
    { ...canonical(), type: "basic" },
  ])
    rejected(() => exportApipostNtlm(value));
});
test("native NTLM validates every credential type and rejects unknown aliases", () => {
  for (const field of ["username", "password", "domain", "workstation"])
    for (const value of [undefined, null, 0, true, {}, []]) {
      rejected(() => importApipostNtlm({ ...native(), [field]: value }));
      rejected(() => exportApipostNtlm({ ...canonical(), [field]: value }));
    }
  rejected(() => importApipostNtlm({ ...native(), username: "" }));
  rejected(() => importApipostNtlm({ ...native(), entity: "Domain" }));
  rejected(() => importApipostNtlm({ ...native(), [secret]: "" }));
  for (const value of [
    null,
    [],
    "text",
    0,
    true,
    new Date(),
    Object.create({ username: "User" }),
  ])
    rejected(() => importApipostNtlm(value));
});
test("native NTLM descriptor boundary never invokes accessors or serialization hooks", () => {
  let invoked = 0;
  for (const direction of ["native", "canonical"]) {
    const convert =
      direction === "native" ? importApipostNtlm : exportApipostNtlm;
    const make = direction === "native" ? native : canonical;
    for (const key of [
      "username",
      "password",
      "domain",
      "workstation",
      direction === "native" ? "disableRetryRequest" : "type",
    ]) {
      const accessor = make();
      Object.defineProperty(accessor, key, {
        enumerable: true,
        get() {
          invoked++;
          return secret;
        },
      });
      rejected(() => convert(accessor));
      const hidden = make();
      Object.defineProperty(hidden, key, {
        enumerable: false,
        value: hidden[key],
      });
      rejected(() => convert(hidden));
    }
    const symbolic = make();
    symbolic[Symbol(secret)] = "";
    rejected(() => convert(symbolic));
    const hook = make();
    hook.toJSON = () => {
      invoked++;
      return {};
    };
    rejected(() => convert(hook));
    const custom = Object.assign(Object.create({ extra: secret }), make());
    rejected(() => convert(custom));
  }
  assert.equal(invoked, 0);
});
test("native NTLM exact UTF-8 output cap includes canonical defaults", () => {
  const base = {
    username: "u",
    password: "",
    domain: "",
    workstation: "",
    disableRetryRequest: false,
  };
  const remaining = 65536 - Buffer.byteLength(JSON.stringify(base));
  const at = { ...base, password: "x".repeat(remaining) };
  assert.equal(Buffer.byteLength(JSON.stringify(at)), 65536);
  assert.deepEqual(exportApipostNtlm(importApipostNtlm(at)).ntlm, at);
  rejected(() => importApipostNtlm({ ...at, password: at.password + "x" }));
  rejected(() =>
    exportApipostNtlm({
      ...importApipostNtlm(at),
      password: at.password + "x",
    }),
  );
  const compact = {
    username: "u",
    password: "x".repeat(
      65536 -
        Buffer.byteLength(JSON.stringify({ username: "u", password: "" })),
    ),
  };
  assert.equal(Buffer.byteLength(JSON.stringify(compact)), 65536);
  rejected(() => importApipostNtlm(compact));
  const unicode = { ...base, password: "雪".repeat(Math.floor(remaining / 3)) };
  assert.doesNotThrow(() => importApipostNtlm(unicode));
  rejected(() =>
    importApipostNtlm({ ...unicode, password: unicode.password + "雪" }),
  );
});
test("native NTLM adapters select only owned data sections and preserve inactive envelopes", () => {
  const envelope = {
    type: "ntlm",
    ntlm: native(),
    oauth2: { access_token: secret },
  };
  const before = structuredClone(envelope);
  assert.deepEqual(importExtendedApipostAuth(envelope), canonical());
  assert.deepEqual(exportExtendedApipostAuth(canonical()), {
    type: "ntlm",
    ntlm: native(),
  });
  assert.deepEqual(envelope, before);
  let read = 0;
  const accessor = { type: "ntlm" };
  Object.defineProperty(accessor, "ntlm", {
    enumerable: true,
    get() {
      read++;
      return native();
    },
  });
  rejected(() => importExtendedApipostAuth(accessor));
  assert.equal(read, 0);
  const inherited = Object.assign(Object.create({ ntlm: native() }), {
    type: "ntlm",
  });
  rejected(() => importExtendedApipostAuth(inherited));
});
