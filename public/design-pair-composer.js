import {
  provisionalQueryEnabled,
  provisionalQueryRequired,
  provisionalQueryType,
} from "./design-query-provisional.js";

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

export function designPairComposer(kind, empty, provisional) {
  const label = kind === "headers" ? "Header" : "Query";
  const add = `<button type="button" class="ghost design-empty-pair" data-add-pair="${kind}" aria-label="＋ 添加参数" title="添加${label}参数">＋</button>`;
  const input = `<input type="text" data-design-pair-name="${kind}" aria-label="新${label}参数名" spellcheck="false" autocomplete="off">`;
  const draft = kind === "query" && empty && provisional;
  return `<tr class="design-pair-composer">
    <td>${draft ? provisionalQueryEnabled(draft) : add}</td>
    <td>${draft ? `<div class="design-query-name">${add}${input}${provisionalQueryType(draft)}</div>` : input}</td>
    <td>${draft ? provisionalQueryRequired(draft) : ""}</td><td class="pair-description"></td>${empty ? "" : "<td></td>"}
  </tr>`;
}
