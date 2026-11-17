import test from "node:test";
import assert from "node:assert/strict";
import { previewImportViews } from "./helpers/preview-draft-ownership-ui.mjs";
import { settingsPanel } from "../public/settings-view.js";
import { settingsSidebar } from "../public/resource-view.js";
import { dictionaryPanel } from "../public/dictionary-view.js";
import { errorCodeHTML } from "../public/error-code-view.js";

test("preview fixture navigates actual editable views, not read-only documentation", () => {
  const project = {
    id: "fixture",
    name: "fixture",
    environments: [],
    parameterDictionary: [{ id: "owned", key: "owned_value", type: "string" }],
    settings: { statusCodes: [{ code: "owned_value", label: "saved value" }] },
  };
  const dictionary = previewImportViews.dictionary;
  assert.equal(dictionary.page, "dictionary");
  const dictionaryHTML = dictionaryPanel(project);
  assert(dictionaryHTML.includes(`id="${dictionary.button.slice(1)}"`));
  assert.match(dictionaryHTML, /<table>[\s\S]*owned_value[\s\S]*<\/table>/);

  const codes = previewImportViews["error-codes"];
  assert.equal(codes.page, "settings");
  const sidebar = settingsSidebar(codes.settingsAnchor);
  assert(
    sidebar.includes(
      `data-settings-anchor="${codes.settingsAnchor}" class="active" aria-current="page"`,
    ),
  );
  const panel = settingsPanel(project, codes.settingsAnchor);
  assert(panel.includes(`id="${codes.button.slice(1)}"`));
  assert.match(
    panel,
    /<div class="page[\s\S]*<table>[\s\S]*owned_value[\s\S]*<\/table>/,
  );
  assert(
    !settingsPanel(project, "settings-basic").includes(
      `id="${codes.button.slice(1)}"`,
    ),
  );
  assert(
    !errorCodeHTML(project.settings.statusCodes).includes(
      `id="${codes.button.slice(1)}"`,
    ),
  );
});
