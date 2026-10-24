const selections = new WeakMap();
const limit = 6 * 1024 * 1024;
export async function applySelectedFormFile(file, field, isCurrent, onApplied) {
  if (!field) return false;
  const token = {};
  selections.set(field, token);
  if (!file) return false;
  if (file.size > limit) throw Error("文件不能超过 6 MiB");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > limit) throw Error("文件不能超过 6 MiB");
  if (selections.get(field) !== token || !isCurrent()) return false;
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  Object.assign(field, {
    type: "file",
    filename: file.name,
    requiresFile: false,
    value: btoa(binary),
  });
  onApplied();
  return true;
}
