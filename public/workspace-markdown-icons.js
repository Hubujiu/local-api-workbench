// Original outlines for the local Markdown workbench's formatting controls.
const shapes = {
  heading: '<path d="M4 2v12m8-12v12M4 8h8"/>',
  bold: '<path d="M4.5 2.5v11h4.4c4 0 4-5.6 0-5.6H4.5m0-5.4h4c3.5 0 3.7 5.4 0 5.4"/>',
  italic: '<path d="M8 2.5h4.5m-3 0-3 11m-3 0H8"/>',
  quote:
    '<path d="M6.6 4c-2.2 1.1-3.3 3.1-3.3 5.1m8.8-5.1c-2.2 1.1-3.3 3.1-3.3 5.1"/><ellipse cx="4.5" cy="9.7" rx="1.6" ry="1.8" fill="currentColor" stroke="none"/><ellipse cx="10" cy="9.7" rx="1.6" ry="1.8" fill="currentColor" stroke="none"/>',
  link: '<g transform="rotate(-43 8 8)"><path d="M6.1 5.5V4a1.9 1.9 0 0 1 3.8 0v1.5m0 5V12a1.9 1.9 0 0 1-3.8 0v-1.5M8 5.7v4.6"/></g>',
  image:
    '<rect x="2.1" y="2.8" width="11.8" height="10.4" rx="1.1"/><circle cx="6" cy="6" r="1.1"/><path d="m2.4 11 3-2.4 2.2 1.7 2.4-3 3.7 4.5"/>',
  code: '<path d="M5 4.1 1.7 8 5 11.9m6-7.8L14.3 8 11 11.9m-1.8-10L6.8 14.1"/>',
  block:
    '<path d="M6 2.3H4.9c-.8 0-1.2.7-1.2 1.5v2.3c0 1.1-.8 1.9-1.7 1.9.9 0 1.7.8 1.7 1.9v2.3c0 .8.4 1.5 1.2 1.5H6m4-11.4h1.1c.8 0 1.2.7 1.2 1.5v2.3c0 1.1.8 1.9 1.7 1.9-.9 0-1.7.8-1.7 1.9v2.3c0 .8-.4 1.5-1.2 1.5H10"/>',
  bullet:
    '<path d="M6 4h8M6 8h8m-8 4h8"/><circle cx="2.7" cy="4" r="1" fill="currentColor" stroke="none"/><circle cx="2.7" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="2.7" cy="12" r="1" fill="currentColor" stroke="none"/>',
  number:
    '<path d="M6.7 4H14m-7.3 4H14m-7.3 4H14"/><path stroke-width="1" d="m2 3.3 1-.7v2.4m-1 .8h2M2 7.5c.2-.6 1.4-.7 1.6-.1.3.7-1.6 1-1.6 1.8h1.7M2 11.2h1.6l-1 .9c1.4-.1 1.4 1.3-.6 1.2"/>',
  strike:
    '<path d="M12.3 4.6c-.4-1.5-1.9-2.5-3.9-2.5-4.1 0-5 3.6-1.1 5.1l2.8 1.1c4.3 1.7 2.7 5.6-1.7 5.6-2.3 0-4-.8-4.7-2.6M2 8h12"/>',
  task: '<path d="M13.4 7.1v5.2c0 .7-.5 1.2-1.2 1.2H3.9c-.7 0-1.2-.5-1.2-1.2V3.9c0-.7.5-1.2 1.2-1.2h7.6M5.3 7.9l2.1 2.2 6.6-6.8"/>',
  table:
    '<rect x="2.5" y="2.5" width="11" height="11" rx="1"/><path d="M2.5 6.2h11m-11 3.6h11M6.2 2.5v11m3.6-11v11"/>',
};
export function workspaceMarkdownIcon(action) {
  if (!Object.hasOwn(shapes, action)) throw Error("未知文档格式图标");
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${shapes[action]}</svg>`;
}
