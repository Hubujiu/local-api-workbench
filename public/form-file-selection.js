const selections = new WeakMap();
const limit = 6 * 1024 * 1024;
export async function applySelectedFormFile(file, field, isCurrent, onApplied) {
  if (!field) return false;
  const token = {};
  selections.set(field, token);
  const owned = () => selections.get(field) === token && isCurrent();
  if (!file || !owned()) return false;
  if (file.size > limit) throw Error("文件不能超过 6 MiB");
  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (error) {
    if (!owned()) return false;
    throw error;
  }
  if (!owned()) return false;
  if (bytes.byteLength > limit) throw Error("文件不能超过 6 MiB");
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
