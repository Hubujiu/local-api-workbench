import { pathToFileURL } from "node:url";

const repo = "Hubujiu/local-api-workbench";
const platforms = ["Windows", "macOS", "Linux"];
export async function deliveryIndex(request, now = Date.now()) {
  const branch = await request("/branches/main");
  const head = branch.commit.sha;
  if (!/^[0-9a-f]{40}$/.test(head)) throw Error("Invalid main commit");
  const tree = branch.commit.commit.tree.sha;
  const runs = await request(
    "/actions/workflows/ci.yml/runs?branch=main&status=success&head_sha=" +
      head,
  );
  const run = runs.workflow_runs.find(
    (r) =>
      r.head_sha === head &&
      r.head_branch === "main" &&
      r.head_repository?.full_name === repo &&
      r.conclusion === "success" &&
      ["push", "workflow_dispatch"].includes(r.event),
  );
  if (!run) throw Error("main " + head + " 尚无通过的同版本构建");
  const attempt = run.run_attempt;
  const jobs = await request(
    `/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100`,
  );
  if (
    !jobs.jobs.some((j) => j.name === "required" && j.conclusion === "success")
  )
    throw Error("缺少同次运行的 required 成功记录");
  const { artifacts } = await request(
    `/actions/runs/${run.id}/artifacts?per_page=100`,
  );
  const downloads = platforms.map((platform) => {
    const matches = artifacts.filter(
      (a) =>
        a.name === "LocalAPI-" + platform + "-portable" &&
        a.workflow_run?.head_sha === head &&
        !a.expired &&
        Date.parse(a.expires_at) > now &&
        /^sha256:[0-9a-f]{64}$/.test(a.digest),
    );
    if (matches.length !== 1)
      throw Error(platform + " 的同版本下载缺失、重复或已过期");
    const artifact = matches[0];
    return {
      platform,
      url: `https://github.com/${repo}/actions/runs/${run.id}/artifacts/${artifact.id}`,
      sha256: artifact.digest.slice(7),
      expires: artifact.expires_at,
    };
  });
  return { head, tree, run: run.id, attempt, downloads };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const get = async (path) => {
    const response = await fetch(
      "https://api.github.com/repos/" + repo + path,
      {
        headers: {
          Accept: "application/vnd.github+json",
          ...(process.env.GH_TOKEN && {
            Authorization: "Bearer " + process.env.GH_TOKEN,
          }),
        },
      },
    );
    if (!response.ok) throw Error("GitHub API HTTP " + response.status);
    return response.json();
  };
  console.log(JSON.stringify(await deliveryIndex(get), null, 2));
}
