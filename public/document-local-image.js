import { inlineImageURI } from "./inline-image.js";
import { insertTextareaText } from "./textarea-edit-history.js";

const imageLimit = 128 * 1024;
const previewLimit = 256 * 1024;
const pngMagic = [137, 80, 78, 71, 13, 10, 26, 10];
const jpegMagic = [255, 216, 255];

export function documentImageMime(bytes, declared) {
  const startsWith = (magic) =>
    magic.every((value, index) => bytes[index] === value);
  if (startsWith(pngMagic)) return "image/png";
  if (startsWith(jpegMagic)) return "image/jpeg";
  if (declared === "image/png") throw Error("PNG文件头无效");
  if (declared === "image/jpeg") throw Error("JPEG文件头无效");
  throw Error("仅支持PNG/JPEG图片");
}

export async function readLocalDocumentImage(
  file,
  decode = (blob) => createImageBitmap(blob),
) {
  if (file.size > imageLimit) throw Error("图片最多128KiB");
  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    throw Error("无法读取本地图片");
  }
  if (bytes.length > imageLimit) throw Error("图片最多128KiB");
  const mime = documentImageMime(bytes, file.type);
  const uri = inlineImageURI(bytes, mime);
  let bitmap;
  try {
    bitmap = await decode(new Blob([bytes], { type: mime }));
  } catch {
    throw Error("图片内容无法解码");
  }
  bitmap.close();
  return uri;
}

export function documentImagePatch(text, end, uri) {
  const before = text.slice(0, end);
  const after = text.slice(end);
  const lead =
    !before || before.endsWith("\n\n")
      ? ""
      : before.endsWith("\n")
        ? "\n"
        : "\n\n";
  const tail =
    !after || after.startsWith("\n\n")
      ? ""
      : after.startsWith("\n")
        ? "\n"
        : "\n\n";
  const insertion = `${lead}![图片](${uri})${tail}`;
  if (text.length + insertion.length > previewLimit)
    throw Error("文档超过256KiB预览限制");
  return insertion;
}

export function bindLocalDocumentImage({
  picker,
  input,
  trigger,
  active,
  notify,
}) {
  let selection,
    revision = 0;
  const capture = () => ({
    revision: ++revision,
    text: input.value,
    start: input.selectionStart,
    end: input.selectionEnd,
    direction: input.selectionDirection,
  });
  const owns = () => active() && picker.isConnected && input.isConnected;
  const current = (ticket) =>
    owns() &&
    revision === ticket.revision &&
    input.value === ticket.text &&
    input.selectionStart === ticket.start &&
    input.selectionEnd === ticket.end &&
    input.selectionDirection === ticket.direction;
  input.addEventListener("input", () => {
    revision++;
  });
  trigger?.addEventListener("click", () => {
    if (!owns()) return;
    selection = capture();
    picker.click();
  });
  if (!trigger)
    picker.addEventListener("click", () => {
      if (owns()) selection = capture();
    });
  const cancel = () => {
    selection = undefined;
    revision++;
    if (owns()) trigger?.focus({ preventScroll: true });
  };
  picker.addEventListener("cancel", cancel);
  picker.addEventListener("change", async () => {
    const file = picker.files?.[0];
    if (!file) return cancel();
    const ticket = selection ?? capture();
    selection = undefined;
    picker.value = ""; // the same local file may be chosen again
    if (!current(ticket)) return;
    try {
      const uri = await readLocalDocumentImage(file);
      if (!current(ticket)) return;
      const insertion = documentImagePatch(ticket.text, ticket.end, uri);
      if (
        !insertTextareaText(input, {
          start: ticket.end,
          end: ticket.end,
          replacement: insertion,
        })
      )
        throw Error("无法在当前编辑器插入图片");
      if (ticket.start !== ticket.end)
        input.setSelectionRange(ticket.start, ticket.end, ticket.direction);
      notify("图片已插入到草稿，尚未保存");
    } catch (error) {
      if (current(ticket)) {
        trigger?.focus({ preventScroll: true });
        notify(error.message);
      }
    }
  });
}
