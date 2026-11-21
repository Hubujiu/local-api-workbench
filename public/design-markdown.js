export const markdownTools = [
  ["heading", "H", "标题"],
  ["bold", "B", "加粗"],
  ["italic", "I", "斜体"],
  ["quote", "❝", "引用"],
  ["link", "↗", "链接"],
  ["code", "‹/›", "行内代码"],
  ["block", "{ }", "代码块"],
  ["bullet", "☷", "无序列表"],
  ["number", "≡", "有序列表"],
  ["strike", "S", "删除线"],
  ["task", "☑", "任务列表"],
  ["table", "▦", "表格"],
];

const inline = {
  bold: ["**", "文字", "**"],
  italic: ["*", "文字", "*"],
  link: ["[", "链接文字", "](https://example.com)"],
  strike: ["~~", "文字", "~~"],
};

const prefix = {
  heading: () => "## ",
  quote: () => "> ",
  bullet: () => "- ",
  number: (i) => i + 1 + ". ",
  task: () => "- [ ] ",
};

function fenceLength(value) {
  let longest = 0;
  for (const [run] of value.matchAll(/`+/g))
    longest = Math.max(longest, run.length);
  return longest + 1;
}

export function markdownEdit(action, text, start, end) {
  if (
    typeof text !== "string" ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    end > text.length
  )
    return null;
  const selected = text.slice(start, end);
  if (Object.hasOwn(inline, action) || action === "code") {
    const marker = action === "code" ? "`".repeat(fenceLength(selected)) : "";
    const padding =
      selected.startsWith("`") || selected.endsWith("`") ? " " : "";
    const [before, fallback, after] =
      action === "code"
        ? [marker + padding, "代码", padding + marker]
        : inline[action];
    const value = selected || fallback;
    return {
      start,
      end,
      replacement: before + value + after,
      anchor: start + before.length,
      length: value.length,
    };
  }
  if (Object.hasOwn(prefix, action)) {
    const lineStart = start === 0 ? 0 : text.lastIndexOf("\n", start - 1) + 1;
    const effectiveEnd = end > start && text[end - 1] === "\n" ? end - 1 : end;
    const lineEnd = text.indexOf("\n", effectiveEnd);
    const stop = lineEnd === -1 ? text.length : lineEnd;
    const lines = text.slice(lineStart, stop).split("\n");
    const replacement = lines
      .map((line, i) => prefix[action](i) + (line || "文字"))
      .join("\n");
    return {
      start: lineStart,
      end: stop,
      replacement,
      anchor: lineStart + prefix[action](0).length,
      length: replacement.length - prefix[action](0).length,
    };
  }
  if (action === "block" || action === "table") {
    const marker = "`".repeat(Math.max(3, fenceLength(selected)));
    const block =
      action === "block"
        ? selected || "代码"
        : "| 列 A | 列 B |\n| --- | --- |\n| 内容 | 内容 |";
    const lead = start && text[start - 1] !== "\n" ? "\n\n" : "";
    const tail = end < text.length && text[end] !== "\n" ? "\n\n" : "";
    const opener = action === "block" ? marker + "\n" : "";
    const closer = action === "block" ? "\n" + marker : "";
    // A table replaces nothing unless the selection was empty.
    if (action === "table" && selected) {
      const pad = selected.endsWith("\n\n")
        ? ""
        : selected.endsWith("\n")
          ? "\n"
          : "\n\n";
      return {
        start: end,
        end,
        replacement: pad + block + tail,
        anchor: end + pad.length,
        length: block.length,
      };
    }
    return {
      start,
      end,
      replacement: lead + opener + block + closer + tail,
      anchor: start + lead.length + opener.length,
      length: block.length,
    };
  }
  return null;
}
