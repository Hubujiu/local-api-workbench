import {
  validateSharedScriptSettings,
  scriptStages,
} from "../public/shared-scripts.js";
export { validateSharedScriptSettings };
export function applySharedScripts(project, request) {
  const result = structuredClone(request);
  if (request.inheritSharedScripts === false) {
    result.sharedBeforeScripts = [];
    result.sharedAfterScripts = [];
  }
  if (
    request.sharedScriptsSnapshot !== true &&
    request.inheritSharedScripts !== false
  ) {
    validateSharedScriptSettings(project.settings);
    const folders = project.settings?.folderScripts || {};
    const configs = [
      ["project", project.settings?.globalScripts],
      [
        "folder",
        Object.hasOwn(folders, request.folder || "")
          ? folders[request.folder]
          : undefined,
      ],
    ];
    for (const [source, target] of [
      ["beforeScript", "sharedBeforeScripts"],
      ["afterScript", "sharedAfterScripts"],
    ])
      result[target] = configs
        .filter(
          ([, config]) =>
            config && config.enabled !== false && config[source]?.trim(),
        )
        .map(([name, config]) => ({ name, code: config[source] }));
  }
  scriptStages(result, "before");
  scriptStages(result, "after");
  return result;
}
