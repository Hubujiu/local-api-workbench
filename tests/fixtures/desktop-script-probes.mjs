// Diagnostics only: the original packaged acceptance remains mandatory.
export function desktopScriptProbes(original) {
  if (typeof original !== "string")
    throw Error("Expected owned desktop fixture source");
  const timed = (code) =>
    `const probeStarted=Date.now();${code};console.log("desktop-probe-ms",Date.now()-probeStarted);`;
  const probes = [
    {
      name: "schema-only",
      code: timed(
        'pm.test("probe-schema",()=>pm.response.to.have.jsonSchema({type:"object",properties:{message:{type:"string"}},required:["message"]}));',
      ),
    },
    {
      name: "utilities-only",
      code: timed(
        'pm.test("probe-utilities",()=>{pm.expect(_.sum([1,2,3])).to.equal(6);pm.expect(csv2array("name,age")[0]).to.deep.equal(["name","age"]);pm.expect(xml2Json("<a>ok</a>").a).to.equal("ok");pm.expect(moment.utc("2024-02-28").add(1,"day").format("YYYY-MM-DD")).to.equal("2024-02-29");pm.expect(uuid.validate(uuid.v4())).to.equal(true);});',
      ),
    },
    {
      name: "json5-crypto-only",
      code: timed(
        'pm.test("probe-json5",()=>pm.expect(require("json5").parse("{unquoted:1,}").unquoted).to.equal(1));pm.test("probe-crypto",()=>pm.expect(CryptoJS.SHA256("abc").toString()).to.equal("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));',
      ),
    },
  ];
  const schema =
    'pm.test("packaged-schema",()=>pm.response.to.have.jsonSchema({type:"object",properties:{message:{type:"string"}},required:["message"]}));';
  const replySchema =
    "pm.expect(reply).to.have.jsonSchema({type:'object',properties:{message:{type:'string'}},required:['message']});";
  if (original.includes(schema) && original.includes(replySchema))
    probes.push({
      name: "combined-without-schema-diagnostic-only",
      code: timed(original.replace(schema, "").replace(replySchema, "")),
    });
  return probes;
}
