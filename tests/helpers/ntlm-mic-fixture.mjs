// Independent fictional server-side byte oracle. No application/runtime imports.
import { createHmac } from "node:crypto";
export const credentials = Object.freeze({
  username: "User",
  password: "Password",
  domain: "Domain",
  workstation: "COMPUTER",
});
const responseKey = Buffer.from("0c868a403bfd7a93a3001ef22ef02e3f", "hex");
const hmac = (key, value) => createHmac("md5", key).update(value).digest();
export const bytes = (header) => Buffer.from(header.slice(5), "base64");
export const header = (message) => "NTLM " + message.toString("base64");
export function av(id, value) {
  const pair = Buffer.alloc(4 + value.length);
  pair.writeUInt16LE(id);
  pair.writeUInt16LE(value.length, 2);
  value.copy(pair, 4);
  return pair;
}
export function challengeMessage({
  timestamp = true,
  flags,
  version = false,
  extra = [],
  padding = 0,
} = {}) {
  const pairs = [
    av(2, Buffer.from("Domain", "utf16le")),
    av(1, Buffer.from("Server", "utf16le")),
  ];
  if (timestamp) pairs.push(av(7, Buffer.from("0011223344556601", "hex")));
  if (flags !== undefined) {
    const value = Buffer.alloc(4);
    value.writeUInt32LE(flags);
    pairs.push(av(6, value));
  }
  pairs.push(...extra, av(0, Buffer.alloc(0)));
  const info = Buffer.concat(pairs),
    start = version ? 56 : 48;
  const message = Buffer.alloc(start + info.length + padding);
  message.write("NTLMSSP\0");
  message.writeUInt32LE(2, 8);
  message.writeUInt32LE((0xa0888205 | (version ? 0x02000000 : 0)) >>> 0, 20);
  Buffer.from("0123456789abcdef", "hex").copy(message, 24);
  message.writeUInt16LE(info.length, 40);
  message.writeUInt16LE(info.length, 42);
  message.writeUInt32LE(start, 44);
  if (version) Buffer.from("0601b11d0000000f", "hex").copy(message, 48);
  info.copy(message, start);
  return message;
}
export function verifyMic(type1, type2, type3) {
  const read = (at) =>
    type3.subarray(
      type3.readUInt32LE(at + 4),
      type3.readUInt32LE(at + 4) + type3.readUInt16LE(at),
    );
  const nt = read(20),
    lm = read(12),
    proof = nt.subarray(0, 16);
  const proofValid = hmac(
    responseKey,
    Buffer.concat([type2.subarray(24, 32), nt.subarray(16)]),
  ).equals(proof);
  const zeroed = Buffer.from(type3),
    mic = Buffer.from(zeroed.subarray(72, 88));
  zeroed.fill(0, 72, 88);
  const expected = hmac(
    hmac(responseKey, proof),
    Buffer.concat([type1, type2, zeroed]),
  );
  const pairs = [];
  for (let at = 44; at + 4 <= nt.length; ) {
    const id = nt.readUInt16LE(at),
      length = nt.readUInt16LE(at + 2);
    pairs.push({
      id,
      value: Buffer.from(nt.subarray(at + 4, at + 4 + length)),
    });
    at += 4 + length;
    if (id === 0) break;
  }
  return { proofValid, micValid: expected.equals(mic), nt, lm, pairs };
}
