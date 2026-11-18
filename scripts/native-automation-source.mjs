#!/usr/bin/env node
import { constants } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import {
  archiveNativeAutomationSource,
  restoreNativeAutomationSource,
  inspectNativeAutomationSource,
  nativeAutomationSourceLimit,
  nativeAutomationArchiveLimit,
} from "../src/native-automation-source-archive.mjs";

async function boundedRead(path, limit) {
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit)
      throw Error("输入必须是大小受限的普通文件");
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size <= limit) {
      const result = await file.read(bytes, size, bytes.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > limit) throw Error("输入超过大小上限");
    return bytes.subarray(0, size);
  } finally {
    await file.close();
  }
}
try {
  const [action, input, output, ...extra] = process.argv.slice(2);
  if (
    !["pack", "inspect", "unpack"].includes(action) ||
    !input ||
    extra.length ||
    (action === "inspect" ? output !== undefined : !output)
  )
    throw Error(
      "用法: node scripts/native-automation-source.mjs pack|unpack 输入 输出；inspect 档案。仅来源保管，不导入或执行自动化",
    );
  const bytes = await boundedRead(
    input,
    action === "pack"
      ? nativeAutomationSourceLimit
      : nativeAutomationArchiveLimit,
  );
  let archive;
  if (action === "pack") archive = archiveNativeAutomationSource(bytes);
  else {
    try {
      archive = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      throw Error("来源档案不是有效UTF-8 JSON");
    }
  }
  const summary = inspectNativeAutomationSource(archive);
  if (action !== "inspect")
    await writeFile(
      output,
      action === "pack"
        ? JSON.stringify(archive, null, 2) + "\n"
        : restoreNativeAutomationSource(archive),
      { flag: "wx", mode: 0o600 },
    );
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  // File-system error messages include paths; do not echo user data into logs.
  console.error(
    error.code ? "来源档案文件操作失败: " + error.code : error.message,
  );
  process.exitCode = 1;
}
