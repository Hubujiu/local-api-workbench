import test from "node:test";
import assert from "node:assert/strict";
import { runScript } from "../src/scripts.mjs";
test("sandbox CryptoJS hashing, HMAC and AES match fixed standard vectors", async () => {
  const result = await runScript(
    `
   apt.setVar("hash",CryptoJS.SHA256("abc").toString());
   apt.setVar("hmac",CryptoJS.HmacSHA256("Hi There",CryptoJS.enc.Hex.parse("0b".repeat(20))).toString());
   const ciphertext=CryptoJS.AES.encrypt(CryptoJS.enc.Hex.parse("00112233445566778899aabbccddeeff"),CryptoJS.enc.Hex.parse("000102030405060708090a0b0c0d0e0f"),{mode:CryptoJS.mode.ECB,padding:CryptoJS.pad.NoPadding});
   apt.setVar("aes",ciphertext.ciphertext.toString());
 `,
    { variables: {} },
  );
  assert.equal(
    result.variables.hash,
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(
    result.variables.hmac,
    "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
  );
  assert.equal(result.variables.aes, "69c4e0d86a7b0430d8cdb78070b4c55a");
});
test("sandbox Chai supports deep assertions and secure random-backed encryption without host access", async () => {
  const result = await runScript(
    `
   const lib=require("crypto-js");
   const encrypted=lib.AES.encrypt("fixture","fixture-passphrase").toString();
   pm.test("decrypt",()=>pm.expect(lib.AES.decrypt(encrypted,"fixture-passphrase").toString(lib.enc.Utf8)).to.equal("fixture"));
   apt.test("deep",()=>apt.expect({a:[1,2]}).to.deep.equal({a:[1,2]}));
   pm.test("properties",()=>pm.expect({x:3}).to.have.property("x").above(2));
   pm.test("failing",()=>pm.expect([1]).to.have.lengthOf(2));
   apt.setVar("random",lib.lib.WordArray.random(16).toString());
   apt.setVar("processType",typeof process);
   apt.setVar("constructorType",__randomBytes.constructor("return typeof process")());
 `,
    { variables: {} },
  );
  assert.deepEqual(
    result.tests.map((t) => t.passed),
    [true, true, true, false],
  );
  assert.match(result.variables.random, /^[a-f0-9]{32}$/);
  assert.equal(result.variables.processType, "undefined");
  assert.equal(result.variables.constructorType, "undefined");
  await assert.rejects(
    runScript('require("node:fs")', { variables: {} }),
    /不允许/,
  );
  await assert.rejects(
    runScript("crypto.getRandomValues(new Uint8Array(65537))", {
      variables: {},
    }),
    /65536/,
  );
});
