// Original line icons. No external image, font, or icon CDN dependency.
const paths = {
  rocket:
    '<path d="M9 15C10 7 15 3 21 3c0 6-4 11-12 12Zm0 0-3-3m3 3 3 3M8 8H4l-2 6 5-1m9 3v4l-6 2 1-5M6 17c-3 0-3 4-3 4s4 0 4-3"/><circle cx="16" cy="8" r="2"/>',
  "◷": '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>',
  "▤": '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 8h8M8 12h5M8 16h7"/>',
  "▧": '<path d="M4 4h7l2 2h7v15h-7l-2-2H4zM12 7v12M7 9h2M15 10h2M7 13h2M15 14h2"/>',
  "♧": '<circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="18" r="2.5"/><circle cx="19" cy="18" r="2.5"/><path d="M12 8v5M5 15v-2h14v2"/>',
  "☷": '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="m7 8 1 1 2-2M12 8h5m-10 5 1 1 2-2M12 13h5M7 18h10"/>',
  "⚙": '<path d="m9 3 1-1h4l1 3 3 1 3 3-2 3 1 3-3 3-3-1-3 2-3-3 1-3-2-3 2-3z"/><circle cx="12" cy="11" r="3"/>',
  "⇄": '<path d="M3 7h17m-4-4 4 4-4 4M21 17H4m4-4-4 4 4 4"/>',
  "▥": '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
  "⑂": '<circle cx="7" cy="4" r="2"/><circle cx="7" cy="20" r="2"/><circle cx="18" cy="7" r="2"/><path d="M7 6v12m0-4h4a7 7 0 0 0 7-5"/>',
  "♲": '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
};
export function icon(name) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${paths[name] || paths["▤"]}</svg>`;
}
