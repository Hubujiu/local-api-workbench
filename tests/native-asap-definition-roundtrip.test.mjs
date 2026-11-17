// Pure definition conversion only. Fake PKCS8 envelopes are intentionally not
// cryptographic keys: this suite never signs, parses a key, or executes an app.
import test from "node:test";
import assert from "node:assert/strict";
import { importExtendedApipostAuth } from "../src/apipost-auth-import.mjs";
import { exportExtendedApipostAuth } from "../src/apipost-auth-export.mjs";
import { asapAlgorithms } from "../public/asap-auth-model.js";

const algorithms = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
];
const begin = "-----BEGIN PRIVATE KEY-----",
  end = "-----END PRIVATE KEY-----";
const pem = (eol = "\n") => [begin, "ZmFrZS1rZXktYnl0ZXM=", end, ""].join(eol);
const rawClaims =
  ' { "role" : "雪", "n":1.00, "escaped":"\\u0061", "dup":1, "dup":2 }\r\n';
const native = (patch = {}) => ({
  alg: "RS256",
  iss: "issuer",
  aud: "audience",
  kid: "issuer/key",
  privateKey: pem(),
  sub: "subject",
  claims: rawClaims,
  exp: 60,
  ...patch,
});
const workbench = (patch = {}) => {
  const { exp, ...fields } = native();
  return { type: "asap", ...fields, ttlSeconds: exp, ...patch };
};
const toNative = ({ type, ttlSeconds, ...fields }) => ({
  type: "asap",
  asap: { ...fields, exp: ttlSeconds },
});
function acceptImport(section, expected) {
  const envelope = { type: "asap", asap: section },
    before = structuredClone(envelope);
  const result = importExtendedApipostAuth(envelope);
  assert.deepEqual(result, expected);
  assert.deepEqual(envelope, before);
  const exported = exportExtendedApipostAuth(result);
  assert.deepEqual(exported, toNative(expected));
  assert.deepEqual(importExtendedApipostAuth(exported), expected);
  assert.deepEqual(
    exportExtendedApipostAuth(importExtendedApipostAuth(exported)),
    exported,
  );
  return result;
}
function acceptExport(auth, expected) {
  const before = structuredClone(auth);
  const output = exportExtendedApipostAuth(auth);
  assert.deepEqual(output, toNative(expected));
  assert.deepEqual(auth, before);
  assert.deepEqual(importExtendedApipostAuth(output), expected);
  assert.deepEqual(
    exportExtendedApipostAuth(importExtendedApipostAuth(output)),
    output,
  );
  return output;
}
const secretMarker = "FICTIONAL_ASAP_SECRET_VALUE_MUST_NOT_ESCAPE";
const unknownMarker = "FICTIONAL_ASAP_PRIVATE_FIELD_MUST_NOT_ESCAPE";
function deny(action, source) {
  const before = structuredClone(source);
  assert.throws(
    () => action(source),
    (error) => {
      assert.ok(error instanceof Error);
      for (const marker of [
        secretMarker,
        unknownMarker,
        "ZmFrZS1rZXktYnl0ZXM=",
        rawClaims,
      ]) {
        assert.equal(String(error).includes(marker), false);
        assert.equal(String(error.stack).includes(marker), false);
        assert.equal(JSON.stringify(error).includes(marker), false);
      }
      assert.equal(
        Object.hasOwn(error, "cause"),
        false,
        "do not attach a raw parser error containing source claims",
      );
      return true;
    },
  );
  assert.deepEqual(source, before);
}
function rejectNative(section) {
  deny(importExtendedApipostAuth, { type: "asap", asap: section });
}
function rejectWorkbench(auth) {
  deny(exportExtendedApipostAuth, auth);
}
function rejectBoth(field, value) {
  rejectNative(native({ [field]: value }));
  rejectWorkbench(workbench({ [field]: value }));
}

test("ASAP canonical definition domain retains the nine existing asymmetric algorithms", () => {
  assert.deepEqual(asapAlgorithms, algorithms);
  for (const alg of algorithms) {
    const expected = workbench({ alg });
    acceptImport(native({ alg }), expected);
    acceptExport(expected, expected);
  }
});

test("native omission and empty expiry/subject/claims use explicit native defaults", () => {
  for (const missing of [true, false]) {
    const source = native();
    for (const field of ["exp", "sub", "claims"]) {
      if (missing) delete source[field];
      else source[field] = "";
    }
    acceptImport(
      source,
      workbench({ ttlSeconds: 3600, sub: "issuer", claims: "{}" }),
    );
  }
  for (const field of ["exp", "sub", "claims"]) {
    const source = native();
    delete source[field];
    acceptImport(
      source,
      workbench(
        field === "exp"
          ? { ttlSeconds: 3600 }
          : field === "sub"
            ? { sub: "issuer" }
            : { claims: "{}" },
      ),
    );
  }
});

test("Workbench omitted/empty algorithm expiry and claims export its own defaults, not native omission defaults", () => {
  for (const missing of [true, false]) {
    const auth = workbench();
    for (const field of ["alg", "ttlSeconds", "claims"]) {
      if (missing) delete auth[field];
      else auth[field] = "";
    }
    acceptExport(
      auth,
      workbench({ alg: "RS256", ttlSeconds: 60, claims: "{}" }),
    );
  }
  for (const sub of [undefined, ""]) {
    const auth = workbench();
    if (sub === undefined) delete auth.sub;
    else auth.sub = sub;
    rejectWorkbench(auth);
  }
  for (const alg of [undefined, ""]) {
    const source = native();
    if (alg === undefined) delete source.alg;
    else source.alg = alg;
    rejectNative(source);
  }
});

test("every integer TTL 1..3600 and its canonical decimal text preserve their number/string representation", () => {
  for (let n = 1; n <= 3600; n++)
    for (const ttl of [n, String(n)]) {
      const imported = importExtendedApipostAuth({
        type: "asap",
        asap: native({ exp: ttl }),
      });
      assert.equal(imported.ttlSeconds, ttl);
      assert.equal(typeof imported.ttlSeconds, typeof ttl);
      const exported = exportExtendedApipostAuth(
        workbench({ ttlSeconds: ttl }),
      );
      assert.equal(exported.asap.exp, ttl);
      assert.equal(typeof exported.asap.exp, typeof ttl);
      assert.deepEqual(
        importExtendedApipostAuth(exported),
        workbench({ ttlSeconds: ttl }),
      );
    }
});

test("TTL rejects noncanonical/coercible or out-of-range definitions in both directions", () => {
  for (const value of [
    null,
    false,
    true,
    0,
    -1,
    3601,
    1.5,
    -0,
    1e20,
    Infinity,
    -Infinity,
    NaN,
    "0",
    "-1",
    "+1",
    "01",
    "00060",
    "1.0",
    "1e2",
    " 60",
    "60 ",
    "\t60",
    "60\n",
    "60seconds",
    "0x10",
    "Infinity",
    "NaN",
    "{{ttl}}",
    [],
    {},
  ]) {
    rejectNative(native({ exp: value }));
    rejectWorkbench(workbench({ ttlSeconds: value }));
  }
});

test("algorithm rejects HMAC none unsupported aliases templates and malformed types", () => {
  for (const alg of [
    "HS256",
    "HS384",
    "HS512",
    "none",
    "EdDSA",
    "RS1024",
    "rs256",
    " RS256",
    "RS256 ",
    "{{alg}}",
    0,
    false,
    null,
    [],
    {},
  ])
    rejectBoth("alg", alg);
});

test("literal issuer/key identifier boundaries and prefix relationship are preserved", () => {
  const issuer = "i".repeat(200),
    kid = issuer + "/" + "k".repeat(299);
  acceptImport(native({ iss: issuer, kid }), workbench({ iss: issuer, kid }));
  acceptExport(
    workbench({ iss: issuer, kid }),
    workbench({ iss: issuer, kid }),
  );
  const iss = "service+v1/team_2.app",
    validKid = iss + "/key-1/rotation.2";
  acceptImport(
    native({ iss, kid: validKid, sub: "  " }),
    workbench({ iss, kid: validKid, sub: "  " }),
  );
  for (const invalid of [
    "",
    ".",
    "..",
    "/issuer",
    "issuer/",
    "issuer//team",
    "issuer/./team",
    "issuer/../team",
    "issuer name",
    "issuer\n",
    "issuer\r\n",
    "issuer:service",
    "issuer@domain",
    "雪",
    "i".repeat(201),
    null,
    0,
    false,
    [],
    {},
  ])
    rejectBoth("iss", invalid);
  for (const invalid of [
    "",
    "issuer/",
    "issuer//key",
    "issuer/./key",
    "issuer/../key",
    "other/key",
    "issuerExtra/key",
    "issuer/key name",
    "issuer/key\n",
    "issuer/key\r\n",
    "issuer/key?x",
    "issuer/key#fragment",
    "issuer/" + "k".repeat(494),
    null,
    0,
    false,
    [],
    {},
  ])
    rejectBoth("kid", invalid);
});

test("native default subject is validated issuer, but explicit subject bytes and 500-character boundary remain unchanged", () => {
  for (const sub of ["subject", " ", "subject/other", "雪", "s".repeat(500)]) {
    acceptImport(native({ sub }), workbench({ sub }));
    acceptExport(workbench({ sub }), workbench({ sub }));
  }
  for (const sub of ["s".repeat(501), null, 0, false, [], {}])
    rejectBoth("sub", sub);
  const source = native({ iss: "bad issuer", kid: "bad issuer/key" });
  delete source.sub;
  rejectNative(source);
});

test("single audience text remains literal, including whitespace, rather than being parsed as an array", () => {
  for (const aud of [
    "audience",
    "  audience  ",
    "https://aud.example.invalid/path",
    "雪",
    "a".repeat(200),
    'literal ["array-looking-suffix"]',
    '"quoted-text"',
  ]) {
    acceptImport(native({ aud }), workbench({ aud }));
    acceptExport(workbench({ aud }), workbench({ aud }));
  }
  for (const aud of [
    "",
    " ",
    "\n\t",
    "a".repeat(201),
    '["audience"]',
    '  ["audience"]  ',
    "[not-json",
    [],
    ["audience"],
    {},
    null,
    1,
    false,
  ])
    rejectBoth("aud", aud);
});

for (const eol of ["\n", "\r\n"])
  test(`literal inline unencrypted PKCS8 ${eol === "\n" ? "LF" : "CRLF"} envelope and raw claims text survive canonical roundtrip`, () => {
    const privateKey = pem(eol);
    const expected = workbench({ privateKey, claims: rawClaims });
    const imported = acceptImport(native({ privateKey }), expected);
    const exported = acceptExport(expected, expected);
    assert.deepEqual(Buffer.from(imported.privateKey), Buffer.from(privateKey));
    assert.deepEqual(
      Buffer.from(exported.asap.privateKey),
      Buffer.from(privateKey),
    );
    assert.equal(imported.claims, rawClaims);
    assert.equal(exported.asap.claims, rawClaims);
  });

test("PEM total byte boundary is 64KiB and conversion never requires a cryptographically valid key", () => {
  const prefix = begin + "\n",
    suffix = "\n" + end + "\n";
  const privateKey =
    prefix + "A".repeat(65536 - Buffer.byteLength(prefix + suffix)) + suffix;
  assert.equal(Buffer.byteLength(privateKey), 65536);
  acceptImport(native({ privateKey }), workbench({ privateKey }));
  acceptExport(workbench({ privateKey }), workbench({ privateKey }));
  rejectBoth(
    "privateKey",
    prefix + "A".repeat(65537 - Buffer.byteLength(prefix + suffix)) + suffix,
  );
  for (const privateKey of [
    "",
    secretMarker,
    "data:application/pkcs8;base64,ZmFrZQ==",
    encodeURIComponent(pem()),
    pem().replaceAll("PRIVATE KEY", "ENCRYPTED PRIVATE KEY"),
    pem().replaceAll("PRIVATE KEY", "RSA PRIVATE KEY"),
    pem().replaceAll("PRIVATE KEY", "EC PRIVATE KEY"),
    pem().replaceAll("PRIVATE KEY", "PUBLIC KEY"),
    begin + "\nZmFrZQ==\n",
    null,
    0,
    false,
    [],
    {},
  ])
    rejectBoth("privateKey", privateKey);
});

test("claims require a bounded JSON object and preserve custom raw JSON without interpreting execution-time nbf", () => {
  for (const claims of [
    "{}",
    " { } \n",
    rawClaims,
    '{"custom":{"iss":"nested-allowed","kid":false},"items":[1,2]}',
    '{"nbf":9999999999}',
  ]) {
    acceptImport(native({ claims }), workbench({ claims }));
    acceptExport(workbench({ claims }), workbench({ claims }));
  }
  const boundary =
    '{"custom":"' +
    "x".repeat(4096 - Buffer.byteLength('{"custom":""}')) +
    '"}';
  assert.equal(Buffer.byteLength(boundary), 4096);
  acceptImport(native({ claims: boundary }), workbench({ claims: boundary }));
  acceptExport(
    workbench({ claims: boundary }),
    workbench({ claims: boundary }),
  );
  for (const claims of [
    boundary + " ",
    " ",
    "[]",
    "null",
    "true",
    "0",
    '"text"',
    '{"broken":' + secretMarker,
    '{"x":"' + "雪".repeat(1400) + '"}',
    {},
    [],
    null,
    0,
    false,
  ])
    rejectBoth("claims", claims);
});

for (const claim of ["iss", "aud", "sub", "iat", "exp", "jti", "kid"])
  test(`claims cannot override ${claim}, even with falsy values`, () => {
    for (const value of [null, false, 0, "", [], {}, secretMarker])
      rejectBoth("claims", JSON.stringify({ [claim]: value }));
  });

test("protected claim parsing catches escaped names and duplicates without normalizing accepted raw text", () => {
  rejectBoth("claims", '{"\\u006b\\u0069\\u0064":false}');
  rejectBoth("claims", '{"iss":"first","iss":null}');
  rejectBoth("claims", '{"kid":0,"kid":false}');
});

test("templates reject in every literal identity/placement/key/claims field and TTL", () => {
  for (const [field, value] of Object.entries({
    alg: "{{algorithm}}",
    iss: "{{issuer}}",
    kid: "issuer/{{key}}",
    aud: "aud-{{name}}",
    sub: "{{subject}}",
    privateKey: begin + "\n{{keyBytes}}\n" + end + "\n",
    claims: '{"custom":{"token":"{{runtimeSecret}}"}}',
  }))
    rejectBoth(field, value);
  rejectNative(native({ exp: "{{seconds}}" }));
  rejectWorkbench(workbench({ ttlSeconds: "{{seconds}}" }));
});

test("unknown section/model fields reject even empty values and never echo arbitrary unknown keys or secrets", () => {
  for (const value of ["", null, false, 0, {}, [], secretMarker]) {
    rejectNative(native({ [unknownMarker]: value }));
    rejectWorkbench(workbench({ [unknownMarker]: value }));
  }
  for (const key of [
    "ttlSeconds",
    "algorithm",
    "secret",
    "token",
    "passphrase",
    "remoteKeyURL",
  ])
    rejectNative(native({ [key]: "" }));
  for (const key of [
    "exp",
    "algorithm",
    "secret",
    "token",
    "passphrase",
    "remoteKeyURL",
  ])
    rejectWorkbench(workbench({ [key]: "" }));
});

test("required native and Workbench identity/key fields cannot be omitted", () => {
  for (const field of ["iss", "aud", "kid", "privateKey"]) {
    const source = native();
    delete source[field];
    rejectNative(source);
    const auth = workbench();
    delete auth[field];
    rejectWorkbench(auth);
  }
  for (const section of [undefined, null, [], "asap", true, 1]) {
    const envelope =
      section === undefined
        ? { type: "asap" }
        : { type: "asap", asap: section };
    deny(importExtendedApipostAuth, envelope);
  }
});

test("accepted definition results are independent copies and source definitions remain unchanged", () => {
  const source = native(),
    before = structuredClone(source);
  const imported = acceptImport(source, workbench());
  imported.privateKey = "later mutation";
  imported.claims = "{}";
  assert.deepEqual(source, before);
  const auth = workbench(),
    original = structuredClone(auth);
  const output = acceptExport(auth, auth);
  output.asap.privateKey = "later mutation";
  output.asap.claims = "{}";
  assert.deepEqual(auth, original);
});

// These descriptor guarantees apply to the directly selected adapter inputs,
// not to arbitrary project normalization or unrelated authentication adapters.
const descriptorRecords = (source) =>
  Reflect.ownKeys(source).map((key) => [
    key,
    Object.getOwnPropertyDescriptor(source, key),
  ]);
function rejectDescriptor(action, source, selected = source) {
  const outer = descriptorRecords(source);
  const inner = descriptorRecords(selected);
  assert.throws(
    () => action(source),
    (error) => {
      for (const marker of [
        secretMarker,
        unknownMarker,
        "ZmFrZS1rZXktYnl0ZXM=",
      ])
        assert.equal(String(error).includes(marker), false);
      return true;
    },
  );
  assert.deepEqual(descriptorRecords(source), outer);
  assert.deepEqual(descriptorRecords(selected), inner);
}

test("selected ASAP definitions accept frozen plain/null-prototype own data without source changes", () => {
  for (const prototype of [Object.prototype, null]) {
    const section = Object.freeze(
      Object.assign(Object.create(prototype), native()),
    );
    const before = descriptorRecords(section);
    assert.deepEqual(
      importExtendedApipostAuth({ type: "asap", asap: section }),
      workbench(),
    );
    assert.deepEqual(descriptorRecords(section), before);
    const auth = Object.freeze(
      Object.assign(Object.create(prototype), workbench()),
    );
    const authBefore = descriptorRecords(auth);
    assert.deepEqual(exportExtendedApipostAuth(auth), toNative(workbench()));
    assert.deepEqual(descriptorRecords(auth), authBefore);
  }
});

test("selected ASAP section/model rejects hidden fields and symbols instead of dropping them", () => {
  for (const mode of ["native", "workbench"]) {
    const base = mode === "native" ? native : workbench;
    const action =
      mode === "native"
        ? (section) =>
            importExtendedApipostAuth({ type: "asap", asap: section })
        : exportExtendedApipostAuth;
    for (const key of [...Object.keys(base()), unknownMarker]) {
      const value = base();
      Object.defineProperty(value, key, {
        value: key === unknownMarker ? secretMarker : value[key],
        enumerable: false,
        configurable: true,
      });
      rejectDescriptor(action, value);
    }
    const undefinedUnknown = base();
    undefinedUnknown[unknownMarker] = undefined;
    rejectDescriptor(action, undefinedUnknown);
    for (const enumerable of [true, false])
      for (const symbol of [Symbol(unknownMarker), Symbol.toStringTag]) {
        const value = base();
        Object.defineProperty(value, symbol, {
          value: secretMarker,
          enumerable,
        });
        rejectDescriptor(action, value);
      }
  }
});

test("selected ASAP accessors and toJSON are rejected without invocation", () => {
  for (const mode of ["native", "workbench"]) {
    const base = mode === "native" ? native : workbench;
    const action =
      mode === "native"
        ? (section) =>
            importExtendedApipostAuth({ type: "asap", asap: section })
        : exportExtendedApipostAuth;
    for (const key of [
      ...Object.keys(base()),
      unknownMarker,
      "toJSON",
      Symbol.toStringTag,
    ])
      for (const enumerable of [true, false]) {
        let gets = 0,
          sets = 0;
        const value = base();
        Object.defineProperty(value, key, {
          get() {
            gets++;
            throw Error(secretMarker);
          },
          set() {
            sets++;
          },
          enumerable,
          configurable: true,
        });
        rejectDescriptor(action, value);
        assert.equal(gets, 0);
        assert.equal(sets, 0);
      }
    let calls = 0;
    const value = base();
    value.toJSON = () => {
      calls++;
      throw Error(secretMarker);
    };
    rejectDescriptor(action, value);
    assert.equal(calls, 0);
  }
});

test("selected ASAP nonplain prototypes and inherited data are rejected", () => {
  for (const mode of ["native", "workbench"]) {
    const base = mode === "native" ? native : workbench;
    const action =
      mode === "native"
        ? (section) =>
            importExtendedApipostAuth({ type: "asap", asap: section })
        : exportExtendedApipostAuth;
    class Definition {
      constructor() {
        Object.assign(this, base());
      }
    }
    for (const value of [
      new Definition(),
      Object.assign([], base()),
      Object.assign(new Date(0), base()),
      Object.assign(Object.create({ inherited: secretMarker }), base()),
      Object.create(base()),
    ])
      rejectDescriptor(action, value);
  }
});

test("native envelope reads only own type/asap data selectors and ignores inactive sections without invoking getters", () => {
  let reads = 0;
  const envelope = { type: "asap", asap: native() };
  for (const key of ["jwt", "hawk", "awsv4", unknownMarker, "toJSON"])
    Object.defineProperty(envelope, key, {
      get() {
        reads++;
        throw Error(secretMarker);
      },
      enumerable: true,
      configurable: true,
    });
  const before = descriptorRecords(envelope);
  assert.deepEqual(importExtendedApipostAuth(envelope), workbench());
  assert.equal(reads, 0);
  assert.deepEqual(descriptorRecords(envelope), before);
  for (const selector of ["type", "asap"]) {
    let gets = 0;
    const invalid = { type: "asap", asap: native() };
    Object.defineProperty(invalid, selector, {
      get() {
        gets++;
        throw Error(secretMarker);
      },
      enumerable: true,
      configurable: true,
    });
    rejectDescriptor(importExtendedApipostAuth, invalid);
    assert.equal(gets, 0);
  }
  for (const invalid of [
    Object.assign(Object.create({ type: "asap" }), { asap: native() }),
    Object.assign(Object.create({ asap: native() }), { type: "asap" }),
  ])
    rejectDescriptor(importExtendedApipostAuth, invalid);
});
