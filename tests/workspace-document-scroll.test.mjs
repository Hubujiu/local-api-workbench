import assert from "node:assert/strict";
import test from "node:test";
import {
  bindWorkspaceDocumentScroll,
  mirroredScrollTop,
} from "../public/workspace-document-scroll.js";

class Pane extends EventTarget {
  constructor(height) {
    super();
    this.scrollHeight = height;
  }
  clientHeight = 100;
  value = 0;
  moves = 0;
  get scrollTop() {
    return this.value;
  }
  set scrollTop(top) {
    this.value = Math.round(top);
    this.moves++;
  }
  scrollTo({ top, behavior }) {
    assert.equal(behavior, "instant");
    this.pendingKeyboardScroll = false;
    this.scrollTop = top;
  }
  scroll(top = this.scrollTop) {
    this.value = top;
    this.dispatchEvent(new Event("scroll"));
  }
}

test("mapping clamps oversized positions and handles panes without scrolling", () => {
  assert.equal(mirroredScrollTop(100, 400, 600), 150);
  assert.equal(mirroredScrollTop(2000, 400, 600), 600);
  assert.equal(mirroredScrollTop(-100, 400, 600), 0);
  assert.equal(mirroredScrollTop(100, 0, 600), 0);
  assert.equal(mirroredScrollTop(100, 400, 0), 0);
  assert.equal(mirroredScrollTop(NaN, 400, 600), 0);
});

test("mirrored events do not rebound; actual competing movement can take ownership", () => {
  const source = new Pane(500),
    rendered = new Pane(700);
  let active = true,
    enabled = true;
  const controls = bindWorkspaceDocumentScroll(source, rendered, {
    active: () => active,
    enabled: () => enabled,
  });
  source.scroll(101);
  assert.equal(rendered.scrollTop, 152);
  rendered.scroll();
  assert.equal(source.moves, 0, "rounded reflected event never rebounds");
  source.scroll(200);
  assert.equal(rendered.scrollTop, 300);
  rendered.scroll(350);
  assert.equal(
    source.scrollTop,
    233,
    "real movement before mirrored notification takes ownership",
  );
  source.scroll();
  assert.equal(rendered.moves, 2);
  enabled = false;
  source.scroll(55);
  assert.equal(rendered.scrollTop, 350);
  rendered.scroll(175);
  assert.equal(source.scrollTop, 55);
  controls.top();
  assert.equal(source.scrollTop, 0);
  assert.equal(rendered.scrollTop, 0);
  enabled = true;
  source.scroll();
  rendered.scroll();
  assert.equal(
    source.moves,
    2,
    "queued programmatic reset events remain harmless",
  );
  active = false;
  source.scroll(60);
  controls.top();
  assert.equal(source.scrollTop, 60);
  assert.equal(rendered.scrollTop, 0);
});

test("refreshing Markdown only redraws the preview's link and does not drive the editor pane", () => {
  const source = new Pane(500),
    rendered = new Pane(700);
  const controls = bindWorkspaceDocumentScroll(source, rendered, {
    active: () => true,
    enabled: () => true,
  });
  source.scroll(200);
  rendered.scrollHeight = 900;
  controls.refreshPreview();
  assert.equal(rendered.scrollTop, 400);
  rendered.scroll();
  assert.equal(source.moves, 0);
});

test("return-to-top cancels a keyboard transition scheduled before the first scroll frame", () => {
  const editor = new Pane(500),
    preview = new Pane(700);
  const controls = bindWorkspaceDocumentScroll(editor, preview, {
    active: () => true,
    enabled: () => false,
  });
  preview.pendingKeyboardScroll = true;
  assert.equal(preview.scrollTop, 0);
  controls.top();
  assert.equal(preview.pendingKeyboardScroll, false);
  assert.equal(editor.scrollTop, 0);
  assert.equal(preview.scrollTop, 0);
});
