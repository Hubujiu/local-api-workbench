// Independently authored public-schema data; no vendor runtime or copied code.
import { nativeProtocolFixture } from "./apipost-native-protocols.mjs";
export function binaryExportFixture(
  url = "ws://127.0.0.1:1/echo?x=one",
  sourceId = "binary-export-source",
) {
  const source = nativeProtocolFixture({ ws: url });
  source.project_id = sourceId;
  source.apis = [source.apis[0]];
  const node = source.apis[0];
  node.project_id = sourceId;
  node.message = [
    ["text", "雪😀\u0000", "text"],
    ["empty-text", "", "text"],
    ["base64", "AP+AwoA=", "base64"],
    ["hex", "00fF80C280", "hexadecimal"],
    ["empty-base64", "", "base64"],
    ["empty-hex", "", "hexadecimal"],
  ].map(([param_id, raw, mode]) => ({
    param_id,
    name: param_id,
    request: { mode, raw },
    response: { mode: "text", raw: "inert example" },
  }));
  return source;
}
export const expectedBinaryExportFrames = [
  { hex: Buffer.from("雪😀\u0000").toString("hex"), binary: false },
  { hex: "", binary: false },
  { hex: "00ff80c280", binary: true },
  { hex: "00ff80c280", binary: true },
  { hex: "", binary: true },
  { hex: "", binary: true },
];
