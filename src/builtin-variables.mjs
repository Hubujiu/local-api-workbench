import { fakerVariable, fakerVariableNames } from "./faker-variables.mjs";
import { randomBytes } from "node:crypto";
/** Serializable factory: no host access beyond its bounded random-byte callback. */
export function builtinVariableFactory(bytes, now, fallback) {
  const integer = (maximum) => {
    const limit = Math.floor(4294967296 / maximum) * maximum;
    for (let attempt = 0; attempt < 16; attempt++) {
      const b = bytes(4),
        n = b[0] * 16777216 + b[1] * 65536 + b[2] * 256 + b[3];
      if (n < limit) return n % maximum;
    }
    throw Error("随机变量生成失败");
  };
  const hex = (count) =>
    Array.from(bytes(count), (n) => n.toString(16).padStart(2, "0")).join("");
  const uuid = () => {
    const b = Array.from(bytes(16));
    b[6] = (b[6] & 15) | 64;
    b[8] = (b[8] & 63) | 128;
    const s = b.map((n) => n.toString(16).padStart(2, "0")).join("");
    return (
      s.slice(0, 8) +
      "-" +
      s.slice(8, 12) +
      "-" +
      s.slice(12, 16) +
      "-" +
      s.slice(16, 20) +
      "-" +
      s.slice(20)
    );
  };
  const alphabet =
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const handlers = {
    $guid: uuid,
    $randomUUID: uuid,
    $timestamp: () => Math.floor(now() / 1000),
    $microTimestamp: () => now(),
    $isoTimestamp: () => new Date(now()).toISOString(),
    $randomAlphaNumeric: () => alphabet[integer(alphabet.length)],
    $randomBoolean: () => Boolean(integer(2)),
    $randomInt: () => integer(1001),
    $randomFloat: () => (integer(4294967296) / 4294967296) * 1000,
    $randomHexColor: () => "#" + hex(3),
    $randomIP: () => Array.from({ length: 4 }, () => integer(256)).join("."),
    $randomIPV6: () => Array.from({ length: 8 }, () => hex(2)).join(":"),
    $randomMACAddress: () => Array.from({ length: 6 }, () => hex(1)).join(":"),
    $randomPassword: () =>
      Array.from({ length: 15 }, () => alphabet[integer(alphabet.length)]).join(
        "",
      ),
    $randomProtocol: () => (integer(2) ? "https" : "http"),
    $randomSemver: () =>
      Array.from({ length: 3 }, () => integer(100)).join("."),
    $randomColor: () =>
      ["navy", "teal", "olive", "coral", "purple", "silver", "lime", "maroon"][
        integer(8)
      ],
    $randomAbbreviation: () =>
      ["API", "HTTP", "CSS", "TLS", "URL", "UTF", "RAM", "CPU"][integer(8)],
  };
  const generate = (key) =>
    Object.prototype.hasOwnProperty.call(handlers, key)
      ? handlers[key]()
      : fallback?.(key);
  generate.names = Object.freeze(Object.keys(handlers));
  return generate;
}
export const builtinVariable = builtinVariableFactory(
  randomBytes,
  () => Date.now(),
  fakerVariable,
);

export const builtinVariableNames = Object.freeze([
  ...builtinVariable.names,
  ...fakerVariableNames,
]);
