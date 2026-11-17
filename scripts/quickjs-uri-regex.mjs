/** Syntax-only adaptation of the pinned fast-uri character classes. */
export function quickJSURIRegex(source) {
  let changed = 0;
  const output = source
    .split("\n")
    .map((line) => {
      if (
        !/^\s*(?:const|var|let) (?:isUnreserved|isPathCharacter|isQueryFragmentCharacter|isUserinfoCharacter|isIPvFuture|isZoneCharacter|nonSimpleDomain|URN_REG) =/.test(
          line,
        )
      )
        return line;
      return line.replace(/\[((?:\\.|[^\]\\])*)\]/g, (whole, body) => {
        if (!body.includes("\\-")) return whole;
        changed++;
        return "[" + body.replaceAll("\\-", "") + "-]";
      });
    })
    .join("\n");
  if (changed !== 9)
    throw Error(
      "Pinned fast-uri regex layout changed; review compatibility adaptation",
    );
  return output;
}
