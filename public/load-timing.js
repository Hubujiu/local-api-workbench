export function loadTiming(options = {}) {
  const mode = options.mode ?? "count";
  if (mode !== "count" && mode !== "duration")
    throw Error("压测模式须为 count 或 duration");
  if (mode === "count") return { mode };
  const durationSeconds = options.durationSeconds;
  if (
    !Number.isInteger(durationSeconds) ||
    durationSeconds < 1 ||
    durationSeconds > 60
  )
    throw Error("压测持续时长须为1至60秒整数");
  return { mode, durationSeconds };
}
