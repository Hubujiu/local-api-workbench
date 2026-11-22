export const projectSwitchPrompt = (page) =>
  page.getByRole("dialog", { name: "切换项目", exact: true });

export async function chooseProjectSwitch(page, choice, open) {
  await open();
  const prompt = projectSwitchPrompt(page);
  await prompt.waitFor();
  await prompt
    .getByRole("button", {
      name: { cancel: "取消", discard: "不保存", save: "保存并继续" }[choice],
      exact: true,
    })
    .press("Enter");
}
