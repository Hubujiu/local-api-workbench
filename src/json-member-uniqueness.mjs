// Only call after JSON.parse has validated grammar. Scan the original token
// stream, not its lossy parsed object, including overwritten subtrees. Decoded
// member names catch Unicode-escaped duplicates. No value is emitted in errors.
export function assertUniqueJSONMembers(text) {
  const fail = () => {
    throw Error("Postman环境JSON存在重复成员或超出结构限制");
  };
  if (Buffer.byteLength(text, "utf8") > 4 * 1024 * 1024) fail();
  const tokens = text.matchAll(
    /"(?:\\.|[^"\\])*"|[{}\[\]:,]|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g,
  );
  let token = tokens.next(),
    nodes = 0;
  const take = () => {
    const raw = token.value?.[0];
    token = tokens.next();
    return raw;
  };
  const scan = (depth) => {
    if (++nodes > 50000 || depth > 50) fail();
    const raw = take();
    if (raw === "{") {
      const names = new Set();
      if (token.value?.[0] === "}") {
        take();
        return;
      }
      while (true) {
        const name = JSON.parse(take());
        if (names.has(name)) fail();
        names.add(name);
        take(); // colon, grammar is already validated
        scan(depth + 1);
        if (take() === "}") return;
      }
    }
    if (raw === "[") {
      if (token.value?.[0] === "]") {
        take();
        return;
      }
      while (true) {
        scan(depth + 1);
        if (take() === "]") return;
      }
    }
  };
  scan(0);
}
