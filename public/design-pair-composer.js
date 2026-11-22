export function isDesignPairKind(kind) {
  return kind === "headers" || kind === "query";
}

export function canComposeDesignPair(kind, page, mode, selected) {
  return (
    page === "apis" &&
    mode === "design" &&
    selected === kind &&
    isDesignPairKind(kind)
  );
}

export function designPairComposer(kind, empty) {
  const label = kind === "headers" ? "Header" : "Query";
  return `<tr class="design-pair-composer">
    <td><button type="button" class="ghost design-empty-pair" data-add-pair="${kind}" aria-label="＋ 添加参数" title="添加${label}参数">＋</button></td>
    <td><input type="text" data-design-pair-name="${kind}" aria-label="新${label}参数名" spellcheck="false" autocomplete="off"></td>
    <td></td><td class="pair-description"></td>${empty ? "" : "<td></td>"}
  </tr>`;
}
