import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type {
  PrWatchCandidate,
  StartPrWatchRequest,
} from "@runweave/shared/pr-watch";
import { SupervisionError } from "../task-supervision/errors";

const exec = promisify(execFile);
async function run(cwd: string, program: string, args: string[]) {
  try {
    const childEnvironment: NodeJS.ProcessEnv = {
      GH_HOST: "github.com",
      GH_PROMPT_DISABLED: "1",
      GIT_TERMINAL_PROMPT: "0",
    };
    for (const key of [
      "PATH",
      "HOME",
      "USERPROFILE",
      "SystemRoot",
      "APPDATA",
      "LOCALAPPDATA",
      "XDG_CONFIG_HOME",
      "GH_CONFIG_DIR",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "NO_PROXY",
      "SSL_CERT_FILE",
    ]) {
      childEnvironment[key] = process.env[key];
    }
    const { stdout } = await exec(program, args, {
      cwd,
      timeout: 8000,
      killSignal: "SIGKILL",
      maxBuffer: 4 * 1024 * 1024,
      env: childEnvironment,
    });
    return stdout.trim();
  } catch {
    throw new SupervisionError(
      `${program} 读取失败，请检查仓库、登录和网络。`,
      422,
    );
  }
}

const name = "[A-Za-z0-9_.-]+";
const remotePattern = new RegExp(
  `^(?:https://(?:[^@/]+@)?github\\.com/|git@github\\.com:|ssh://(?:[^@/]+@)?(?:ssh\\.)?github\\.com(?::\\d+)?/)(${name}/${name})/?$`,
  "i",
);
const urlPattern = new RegExp(
  `^https://github\\.com/(${name}/${name})/pull/([1-9][0-9]*)/?$`,
  "i",
);

async function repositories(cwd: string) {
  const repos = await Promise.all(
    ["origin", "upstream"].map(async (remote) => {
      const url = await run(cwd, "git", ["remote", "get-url", remote]).catch(
        () => "",
      );
      return remotePattern
        .exec(url)?.[1]
        ?.replace(/\.git$/i, "")
        .toLowerCase();
    }),
  );
  if (!repos.some(Boolean))
    throw new SupervisionError("终端仓库没有 GitHub origin 或 upstream。", 403);
  return repos;
}

export async function validatePrUrl(cwd: string, url: string) {
  const repo = urlPattern.exec(url)?.[1]?.toLowerCase();
  if (!repo || !(await repositories(cwd)).includes(repo))
    throw new SupervisionError("仅允许当前仓库的 PR。", 403);
}

const summary = z.object({
  number: z.number().int().positive(),
  url: z.string(),
  title: z.string(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
});
function candidate(
  raw: z.infer<typeof summary>,
  repo: string,
): PrWatchCandidate {
  const match = urlPattern.exec(raw.url);
  if (match?.[1]?.toLowerCase() !== repo || Number(match[2]) !== raw.number)
    throw new SupervisionError("PR 与终端仓库不匹配。", 403);
  return {
    repoNameWithOwner: repo,
    prNumber: raw.number,
    prUrl: raw.url,
    prTitle: raw.title,
  };
}

export async function findPr(
  cwd: string,
  request: Partial<StartPrWatchRequest>,
) {
  const repos = await repositories(cwd);
  const match = request.prUrl ? urlPattern.exec(request.prUrl) : null;
  const repo = match?.[1]?.toLowerCase() ?? repos.find(Boolean)!;
  if ((request.prUrl && !match) || !repos.includes(repo))
    throw new SupervisionError("仅允许当前仓库的 PR。", 403);
  const number = match ? Number(match[2]) : request.prNumber;
  const ref = number
    ? String(number)
    : await run(cwd, "git", ["branch", "--show-current"]);
  if (!ref) throw new SupervisionError("请选择 PR 编号。", 422);
  if (!number) {
    const branchPr = summary.extend({
      headRepositoryOwner: z.object({ login: z.string() }).nullable(),
      headRepository: z.object({ name: z.string() }).nullable(),
    });
    const candidates: PrWatchCandidate[] = [];
    for (const base of new Set(repos)) {
      if (!base) continue;
      const rows = z
        .array(branchPr)
        .parse(
          JSON.parse(
            await run(cwd, "gh", [
              "pr",
              "list",
              "--repo",
              base,
              "--head",
              ref,
              "--state",
              "open",
              "--limit",
              "100",
              "--json",
              "number,url,title,state,headRepository,headRepositoryOwner",
            ]),
          ),
        );
      for (const item of rows) {
        const headRepo =
          `${item.headRepositoryOwner?.login}/${item.headRepository?.name}`.toLowerCase();
        if (item.state === "OPEN" && repos.includes(headRepo))
          candidates.push(candidate(item, base));
      }
    }
    return candidates.length === 1 ? candidates[0]! : null;
  }
  const raw = summary.parse(
    JSON.parse(
      await run(cwd, "gh", [
        "pr",
        "view",
        "--repo",
        repo,
        "--json",
        "number,url,title,state",
        "--",
        ref,
      ]),
    ),
  );
  const result = candidate(raw, repo);
  if (number && number !== result.prNumber)
    throw new SupervisionError("PR 编号已变化。", 409);
  return raw.state === "OPEN" ? result : null;
}

const author = z.object({ login: z.string() }).nullable();
const remark = z.object({
  id: z.string(),
  author,
  body: z.string(),
  createdAt: z.string(),
});
const check = z.object({
  id: z.string(),
  name: z.string().optional(),
  context: z.string().optional(),
  status: z.string().optional(),
  conclusion: z.string().nullable().optional(),
  state: z.string().optional(),
  detailsUrl: z.string().nullable().optional(),
  targetUrl: z.string().nullable().optional(),
});
const checkFields = `pageInfo { hasNextPage endCursor }
  nodes { ... on CheckRun { id name status conclusion detailsUrl } ... on StatusContext { id context state targetUrl } }`;
const fields = `number url title state headRefOid author { login } mergeable mergeQueueEntry { id }
  comments(last:60) { nodes { id author { login } body createdAt } }
  reviews(last:60) { nodes { id author { login } body createdAt } }
  commits(last:1) { nodes { commit { id statusCheckRollup { contexts(first:100) { ${checkFields}
  } } } } }`;
const query = `query($owner:String!, $repo:String!, $number:Int!) {
  repository(owner:$owner,name:$repo) { pullRequest(number:$number) { ${fields} } }
}`;
const contexts = z.object({
  pageInfo: z.object({
    hasNextPage: z.boolean(),
    endCursor: z.string().nullable(),
  }),
  nodes: z.array(check),
});
const pr = summary.extend({
  headRefOid: z.string().min(1),
  author,
  mergeable: z.string(),
  mergeQueueEntry: z.object({ id: z.string() }).nullable(),
  comments: z.object({ nodes: z.array(remark) }),
  reviews: z.object({ nodes: z.array(remark) }),
  commits: z.object({
    nodes: z
      .array(
        z.object({
          commit: z.object({
            id: z.string(),
            statusCheckRollup: z.object({ contexts }).nullable(),
          }),
        }),
      )
      .min(1),
  }),
});

export async function readPr(cwd: string, target: PrWatchCandidate) {
  const repo = target.repoNameWithOwner;
  if (!(await repositories(cwd)).includes(repo))
    throw new SupervisionError("终端远端仓库已变化。", 403);
  const [owner, repository] = repo.split("/");
  const raw = await run(cwd, "gh", [
    "api",
    "--hostname",
    "github.com",
    "graphql",
    "-f",
    `query=${query}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `repo=${repository}`,
    "-F",
    `number=${target.prNumber}`,
  ]);
  const result = pr.parse(JSON.parse(raw).data.repository.pullRequest);
  candidate(result, repo);
  if (result.number !== target.prNumber)
    throw new SupervisionError("读取到其他 PR。", 403);
  const commit = result.commits.nodes[0]!.commit;
  let page = commit.statusCheckRollup?.contexts;
  const checks = [...(page?.nodes ?? [])];
  const deadline = Date.now() + 8000;
  while (result.state === "OPEN" && page?.pageInfo.hasNextPage) {
    const cursor = page.pageInfo.endCursor;
    if (!cursor || Date.now() >= deadline)
      throw new SupervisionError("读取 Check 分页超时。", 422);
    const next = await run(cwd, "gh", [
      "api",
      "--hostname",
      "github.com",
      "graphql",
      "-f",
      `query=query($id:ID!, $after:String!) { node(id:$id) { ... on Commit { statusCheckRollup { contexts(first:100,after:$after) { ${checkFields} } } } } }`,
      "-f",
      `id=${commit.id}`,
      "-f",
      `after=${cursor}`,
    ]);
    page = contexts.parse(
      JSON.parse(next).data.node.statusCheckRollup.contexts,
    );
    checks.push(...page.nodes);
  }
  const inline =
    result.state === "OPEN"
      ? z
          .array(
            z.object({
              node_id: z.string(),
              user: author,
              body: z.string(),
              created_at: z.string(),
            }),
          )
          .parse(
            JSON.parse(
              await run(cwd, "gh", [
                "api",
                "--hostname",
                "github.com",
                `repos/${repo}/pulls/${target.prNumber}/comments?sort=created&direction=desc&per_page=60`,
              ]),
            ),
          )
      : [];
  return {
    ...candidate(result, repo),
    state: result.state,
    head: result.headRefOid,
    conflict: result.mergeable === "CONFLICTING",
    mergeable: result.mergeable,
    queued: !!result.mergeQueueEntry,
    author: result.author?.login,
    checks: checks.map((c) => ({
      id: c.id,
      name: c.name ?? c.context ?? c.id,
      status: c.conclusion ?? c.state ?? c.status ?? "",
      url: c.detailsUrl ?? c.targetUrl ?? "",
    })),
    remarks: [
      ...result.comments.nodes,
      ...result.reviews.nodes,
      ...inline.map((c) => ({
        id: c.node_id,
        author: c.user,
        body: c.body,
        createdAt: c.created_at,
      })),
    ].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  };
}
export type PrSnapshot = Awaited<ReturnType<typeof readPr>>;
