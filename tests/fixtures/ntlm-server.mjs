import http from "node:http";
import { createHmac } from "node:crypto";
// Test-only server: independent proof validation with the published fictional credentials.
export async function startNtlmFixture() {
  const info = Buffer.from(
    "02000c0044006f006d00610069006e0001000c0053006500720076006500720000000000",
    "hex",
  );
  const type2 = Buffer.alloc(48 + info.length);
  type2.write("NTLMSSP\0");
  type2.writeUInt32LE(2, 8);
  type2.writeUInt32LE(0xa0888205, 20);
  Buffer.from("0123456789abcdef", "hex").copy(type2, 24);
  type2.writeUInt16LE(info.length, 40);
  type2.writeUInt16LE(info.length, 42);
  type2.writeUInt32LE(48, 44);
  info.copy(type2, 48);
  const stats = { type1: 0, type3: 0, sockets: new Set() };
  const server = http.createServer(async (req, res) => {
    try {
      for await (const _chunk of req) {
      }
      const token = Buffer.from(
        (req.headers.authorization || "").slice(5),
        "base64",
      );
      if (
        token.length < 12 ||
        token.subarray(0, 8).toString() !== "NTLMSSP\0"
      ) {
        res.writeHead(401, { "www-authenticate": "NTLM" });
        res.end();
        return;
      }
      stats.sockets.add(req.socket);
      if (token.readUInt32LE(8) === 1) {
        stats.type1++;
        res.writeHead(401, {
          "www-authenticate": "NTLM " + type2.toString("base64"),
          connection: "keep-alive",
        });
        res.end();
        return;
      }
      stats.type3++;
      const length = token.readUInt16LE(20),
        offset = token.readUInt32LE(24),
        nt = token.subarray(offset, offset + length);
      const proof = createHmac(
        "md5",
        Buffer.from("0c868a403bfd7a93a3001ef22ef02e3f", "hex"),
      )
        .update(
          Buffer.concat([
            Buffer.from("0123456789abcdef", "hex"),
            nt.subarray(16),
          ]),
        )
        .digest();
      const passed =
        token.readUInt32LE(8) === 3 && proof.equals(nt.subarray(0, 16));
      res.writeHead(passed ? 200 : 403, { "content-type": "application/json" });
      res.end(JSON.stringify({ ntlm: passed }));
    } catch {
      res.statusCode = 400;
      res.end("invalid fixture request");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: "http://127.0.0.1:" + server.address().port,
    stats,
    close: async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
