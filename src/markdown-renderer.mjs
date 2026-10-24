import { validInlineImage, inlineImagePixels } from "../public/inline-image.js";
import MarkdownIt from "markdown-it";
const markdown = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
  breaks: false,
  maxNesting: 30,
});
markdown.validateLink = (value) =>
  validInlineImage(value) ||
  (/^(https?:\/\/|mailto:|#)/i.test(value) &&
    !/[\u0000-\u0020\u007f]/.test(value));
let renderedPixels = 0;
markdown.renderer.rules.image = (tokens, index) => {
  const token = tokens[index],
    src = token.attrGet("src"),
    alt = markdown.utils.escapeHtml(token.content);
  const pixels = inlineImagePixels(src);
  if (!pixels || renderedPixels + pixels > 16000000) return alt;
  renderedPixels += pixels;
  return (
    '<img src="' +
    markdown.utils.escapeHtml(src) +
    '" alt="' +
    alt +
    '" loading="lazy">'
  );
};
const linkOpen = markdown.renderer.rules.link_open;
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  if (tokens[index].attrGet("href")?.startsWith("data:"))
    tokens[index].attrs = tokens[index].attrs.filter(([key]) => key !== "href");
  return linkOpen
    ? linkOpen(tokens, index, options, env, self)
    : self.renderToken(tokens, index, options);
};
export function renderMarkdown(source) {
  const text = String(source ?? "");
  if (text.length > 256 * 1024)
    return "<p>文档超过256KiB预览限制，请导出Markdown查看原文。</p>";
  renderedPixels = 0;
  return markdown.render(text);
}
