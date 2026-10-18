import MarkdownIt from "markdown-it";
const markdown = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
  breaks: false,
  maxNesting: 30,
});
markdown.validateLink = (value) =>
  /^(https?:\/\/|mailto:|#)/i.test(value) &&
  !/[\u0000-\u0020\u007f]/.test(value);
markdown.disable("image");
export function renderMarkdown(source) {
  const text = String(source ?? "");
  if (text.length > 256 * 1024)
    return "<p>文档超过256KiB预览限制，请导出Markdown查看原文。</p>";
  return markdown.render(text);
}
