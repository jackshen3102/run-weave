# Preview File Search VS Code-Style Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Terminal Preview file search behave closer to VS Code Quick Open by using `rg --files` for candidate discovery, project-level candidate caching, safer ignore behavior, and improved fuzzy ranking.

**Architecture:** Make project-scoped Preview API the only supported Preview API. Delete the old session-scoped Preview routes and frontend service wrappers, then refactor the backend search internals behind `searchPreviewFiles(...)`: candidate discovery becomes `rg --files` with a filesystem fallback, ranking stays server-side, and repeated keystrokes reuse a short-lived project file-list cache. The frontend keeps its current debounced search flow and only receives better-ranked results from the same response shape.

**Tech Stack:** Node.js, Express, TypeScript, Vitest, Playwright, `ripgrep` via `execFile`, React/Vite frontend.

---

## Background

Current implementation in `backend/src/terminal/preview.ts`:

- Recursively scans project files with `readdir`.
- Excludes a hard-coded set of directories.
- Ranks with a local fuzzy function.
- Does not respect `.gitignore`.
- Re-scans the filesystem on every search request.

VS Code Quick Open uses a different split:

- `rg --files` produces candidate file paths.
- Search/exclude/ignore rules shape candidate discovery.
- VS Code passes `--hidden`, but also applies `files.exclude` and `search.exclude` globs. Its defaults exclude VCS/system folders such as `.git`, `.svn`, `.hg`, `.DS_Store`, `Thumbs.db`, and search-heavy folders such as `node_modules` and `bower_components`.
- A file query cache avoids a full rescan while the picker is open.
- VS Code applies its own fuzzy scoring and history mixing after candidate discovery.

This plan borrows the pieces that fit Runweave Preview without copying all VS Code behavior.

## File Structure

- Modify `backend/src/terminal/preview.ts`
  - Keep exported API names stable: `searchPreviewFiles`, `readPreviewFile`, git preview helpers.
  - Add `rg --files` candidate discovery.
  - Add short-lived candidate cache.
  - Preserve project-path safety and sensitive-file exclusion.

- Create `backend/src/terminal/preview-file-search.test.ts`
  - Direct unit coverage for `searchPreviewFiles`.
  - Tests should use temp directories and real gitignore files.
  - Tests should not depend on frontend or Express routes.

- Modify `backend/src/routes/terminal.test.ts`
  - Keep existing project preview route coverage.
  - Add one route-level test proving ignored files do not appear in file search.
  - Remove legacy session preview route expectations.

- Modify `backend/src/routes/terminal.ts`
  - Delete `/session/:id/preview/files/search`, `/session/:id/preview/file`, `/session/:id/preview/git-changes`, and `/session/:id/preview/file-diff`.
  - Keep only `/project/:id/preview/...` routes.

- Modify `frontend/src/services/terminal.ts`
  - Delete legacy `searchTerminalPreviewFiles`, `getTerminalPreviewFile`, `getTerminalPreviewGitChanges`, and `getTerminalPreviewFileDiff`.
  - Keep project-scoped `searchTerminalProjectPreviewFiles`, `getTerminalProjectPreviewFile`, `getTerminalProjectPreviewGitChanges`, and `getTerminalProjectPreviewFileDiff`.

- Modify `frontend/src/services/terminal.test.ts`
  - Remove legacy session-scoped Preview service tests.
  - Keep project-scoped Preview service URL tests.

- Modify `frontend/tests/terminal-preview.spec.ts`
  - Add one E2E check that `node_modules` / ignored files do not appear in the Preview file picker.

- Optional later split after green: `backend/src/terminal/preview-file-search.ts`
  - Only extract after tests pass if `preview.ts` becomes materially harder to read.
  - Do not extract before Task 5.

## Behavioral Requirements

- Use project path as the search root.
- Return the existing response shape:

```ts
{
  kind: "file-search";
  projectId: string;
  projectPath: string;
  query: string;
  absoluteInput: boolean;
  items: TerminalPreviewFileSearchItem[];
}
```

- Preserve existing behavior for:
  - Empty query returns `items: []`.
  - Absolute query returns `items: []` and `absoluteInput: true`.
  - `limit` defaults to `50` and is clamped to `1..100`.
  - Results are relative paths with `/` separators.

- Change behavior:
  - Respect `.gitignore` by default through `rg --files`.
  - Keep `--hidden` like VS Code so useful dotfiles such as `.vscode/settings.json`, `.github/workflows/*.yml`, and `.husky/pre-commit` remain searchable unless explicitly excluded.
  - Apply a VS Code-inspired baseline exclude set so hidden/system/generated folders do not flood results.
  - Exclude sensitive env files from search results while allowing committed templates such as `.env.example` and `.env.sample`.
  - Avoid rescanning files on every keystroke within the cache TTL.
  - Prefer exact relative path and basename matches over weak subsequence matches.

- Fallback behavior:
  - If `rg` is unavailable or fails unexpectedly, fallback to the existing recursive `readdir` collection.
  - Fallback must still exclude sensitive files and heavy directories.

- API compatibility:
  - Session-scoped Preview routes are intentionally removed. Preview is project-scoped now, and keeping session aliases makes cache invalidation and ownership semantics ambiguous.
  - Do not keep compatibility wrappers for `/api/terminal/session/:id/preview/...`; those routes should return 404 after removal.

## Task 1: Add Direct Backend Tests for Search Semantics

**Files:**

- Create: `backend/src/terminal/preview-file-search.test.ts`
- Modify: none

- [ ] **Step 1: Write the failing test file**

Create `backend/src/terminal/preview-file-search.test.ts` with:

```ts
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { searchPreviewFiles } from "./preview";

const tempDirs: string[] = [];

async function createProject(): Promise<string> {
  const projectPath = await mkdtemp(path.join(os.tmpdir(), "preview-search-"));
  tempDirs.push(projectPath);
  return projectPath;
}

describe("preview file search", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
    tempDirs.length = 0;
  });

  it("respects gitignore when searching files", async () => {
    const projectPath = await createProject();
    await mkdir(path.join(projectPath, "src"), { recursive: true });
    await mkdir(path.join(projectPath, "dist"), { recursive: true });
    await writeFile(path.join(projectPath, ".gitignore"), "dist/\n");
    await writeFile(
      path.join(projectPath, "src/terminal-preview.ts"),
      "export {};\n",
    );
    await writeFile(
      path.join(projectPath, "dist/terminal-preview.js"),
      "ignored\n",
    );

    const payload = await searchPreviewFiles({
      projectId: "project-1",
      projectPath,
      query: "terminal preview",
      limit: 20,
    });

    expect(payload.items.map((item) => item.path)).toContain(
      "src/terminal-preview.ts",
    );
    expect(payload.items.map((item) => item.path)).not.toContain(
      "dist/terminal-preview.js",
    );
  });

  it("excludes sensitive env files while keeping safe env templates searchable", async () => {
    const projectPath = await createProject();
    await writeFile(path.join(projectPath, ".env"), "SECRET=1\n");
    await writeFile(path.join(projectPath, ".env.local"), "SECRET=2\n");
    await writeFile(
      path.join(projectPath, ".env.development.local"),
      "SECRET=3\n",
    );
    await writeFile(path.join(projectPath, ".env.example"), "PUBLIC_VALUE=1\n");
    await writeFile(path.join(projectPath, ".env.sample"), "PUBLIC_VALUE=2\n");
    await writeFile(
      path.join(projectPath, "config.local"),
      "not an env file\n",
    );
    await writeFile(path.join(projectPath, "environment-notes.md"), "notes\n");

    const payload = await searchPreviewFiles({
      projectId: "project-1",
      projectPath,
      query: "env",
      limit: 20,
    });

    expect(payload.items.map((item) => item.path)).toContain(
      "environment-notes.md",
    );
    expect(payload.items.map((item) => item.path)).toContain("config.local");
    expect(payload.items.map((item) => item.path)).toContain(".env.example");
    expect(payload.items.map((item) => item.path)).toContain(".env.sample");
    expect(payload.items.map((item) => item.path)).not.toContain(".env");
    expect(payload.items.map((item) => item.path)).not.toContain(".env.local");
    expect(payload.items.map((item) => item.path)).not.toContain(
      ".env.development.local",
    );
  });

  it("keeps useful hidden project config searchable while excluding hidden system folders", async () => {
    const projectPath = await createProject();
    await mkdir(path.join(projectPath, ".vscode"), { recursive: true });
    await mkdir(path.join(projectPath, ".git/hooks"), { recursive: true });
    await writeFile(
      path.join(projectPath, ".vscode/preview-settings.json"),
      "{}\n",
    );
    await writeFile(
      path.join(projectPath, ".git/hooks/preview-hook"),
      "ignored\n",
    );
    await writeFile(path.join(projectPath, ".DS_Store"), "ignored\n");

    const payload = await searchPreviewFiles({
      projectId: "project-1",
      projectPath,
      query: "preview",
      limit: 20,
    });

    expect(payload.items.map((item) => item.path)).toContain(
      ".vscode/preview-settings.json",
    );
    expect(payload.items.map((item) => item.path)).not.toContain(
      ".git/hooks/preview-hook",
    );
    expect(payload.items.map((item) => item.path)).not.toContain(".DS_Store");
  });

  it("ranks exact relative path matches before weak basename matches", async () => {
    const projectPath = await createProject();
    await mkdir(path.join(projectPath, "docs/architecture"), {
      recursive: true,
    });
    await mkdir(path.join(projectPath, "src/preview"), { recursive: true });
    await writeFile(
      path.join(projectPath, "docs/architecture/terminal-code-preview.md"),
      "# Preview\n",
    );
    await writeFile(
      path.join(projectPath, "src/preview/terminal.ts"),
      "export {};\n",
    );

    const payload = await searchPreviewFiles({
      projectId: "project-1",
      projectPath,
      query: "docs architecture terminal code preview",
      limit: 20,
    });

    expect(payload.items[0]?.path).toBe(
      "docs/architecture/terminal-code-preview.md",
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --filter @browser-viewer/backend exec vitest run src/terminal/preview-file-search.test.ts
```

Expected:

- At least the `.gitignore` test fails because current `readdir` search returns ignored files when they match.
- The env exclusion test may fail depending on current hidden-file behavior; if it passes, keep it as regression coverage.
- The ranking test may fail if current scoring favors basename-only matches.

- [ ] **Step 3: Commit tests**

Do not commit red tests alone unless the team explicitly wants red commits. Otherwise keep changes staged locally and continue to Task 2.

## Task 2: Replace Candidate Discovery with `rg --files`

**Files:**

- Modify: `backend/src/terminal/preview.ts`
- Test: `backend/src/terminal/preview-file-search.test.ts`

- [ ] **Step 1: Add candidate discovery helpers**

In `backend/src/terminal/preview.ts`, near the existing search constants, replace or extend constants with:

```ts
const SEARCH_MAX_FILES = 20_000;
const DEFAULT_SEARCH_LIMIT = 50;
const RG_SEARCH_TIMEOUT_MS = 5_000;
const SENSITIVE_FILE_GLOBS = [
  ".env",
  "**/.env",
  ".env.local",
  "**/.env.local",
  ".env.*.local",
  "**/.env.*.local",
  "**/*secret*",
  "**/*secrets*",
];
const SAFE_ENV_TEMPLATE_FILES = new Set([
  ".env.example",
  ".env.sample",
  ".env.template",
  ".env.defaults",
]);
const EXCLUDED_DIRECTORIES = new Set([
  ".cache",
  ".git",
  ".hg",
  ".next",
  ".svn",
  ".turbo",
  "CVS",
  "bower_components",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
  "vendor",
]);
const EXCLUDED_FILE_BASENAMES = new Set([".DS_Store", "Thumbs.db"]);
const EXCLUDED_FILE_SUFFIXES = [".code-search"];
```

This intentionally does not exclude `.vscode`, `.github`, or `.husky` by default. VS Code keeps hidden files searchable by passing `--hidden`; these folders often contain useful project configuration. If Runweave later needs user-configurable excludes, add a project setting instead of hard-coding those folders.

Add these helpers below `collectFiles` or replace `collectFiles` with them:

```ts
function toRgExcludeGlob(directoryName: string): string {
  return `!**/${directoryName}/**`;
}

function buildRgFileArgs(): string[] {
  const args = [
    "--files",
    "--hidden",
    "--case-sensitive",
    "--no-require-git",
    "--no-config",
  ];

  for (const directoryName of EXCLUDED_DIRECTORIES) {
    args.push("-g", toRgExcludeGlob(directoryName));
  }
  for (const fileBasename of EXCLUDED_FILE_BASENAMES) {
    args.push("-g", `!**/${fileBasename}`);
  }
  for (const fileSuffix of EXCLUDED_FILE_SUFFIXES) {
    args.push("-g", `!**/*${fileSuffix}`);
  }
  for (const sensitiveGlob of SENSITIVE_FILE_GLOBS) {
    args.push("-g", `!${sensitiveGlob}`);
  }

  return args;
}

function normalizeRgFileList(stdout: string): string[] {
  return stdout
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((filePath) => filePath.split(path.sep).join("/"))
    .filter((filePath) => !path.isAbsolute(filePath))
    .slice(0, SEARCH_MAX_FILES);
}

async function collectFilesWithRipgrep(rootPath: string): Promise<string[]> {
  const { stdout } = await execFileAsync("rg", buildRgFileArgs(), {
    cwd: rootPath,
    maxBuffer: 8 * 1024 * 1024,
    timeout: RG_SEARCH_TIMEOUT_MS,
  });

  return normalizeRgFileList(stdout);
}

function describeRipgrepFailure(error: unknown): string {
  if (error instanceof Error) {
    const errorWithCode = error as Error & {
      code?: string;
      signal?: string;
      killed?: boolean;
    };
    return [
      error.message,
      errorWithCode.code ? `code=${errorWithCode.code}` : null,
      errorWithCode.signal ? `signal=${errorWithCode.signal}` : null,
      errorWithCode.killed ? "killed=true" : null,
    ]
      .filter(Boolean)
      .join(" ");
  }
  return String(error);
}

function shouldWarnRipgrepFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return true;
  }
  const errorWithCode = error as Error & {
    code?: string;
    signal?: string;
    killed?: boolean;
  };
  if (errorWithCode.code === "ENOENT") {
    return false;
  }
  return Boolean(
    errorWithCode.killed ||
    errorWithCode.signal ||
    errorWithCode.code === "ETIMEDOUT" ||
    errorWithCode.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
    errorWithCode.code,
  );
}

function isSensitiveSearchPath(relativePath: string): boolean {
  const basename = path.posix.basename(relativePath).toLowerCase();
  if (SAFE_ENV_TEMPLATE_FILES.has(basename)) {
    return false;
  }
  if (
    basename === ".env" ||
    (basename.startsWith(".env.") && basename.endsWith(".local"))
  ) {
    return true;
  }
  return basename.includes("secret");
}

function shouldIncludeFallbackFile(relativePath: string): boolean {
  if (isSensitiveSearchPath(relativePath)) {
    return false;
  }
  const basename = path.posix.basename(relativePath);
  if (EXCLUDED_FILE_BASENAMES.has(basename)) {
    return false;
  }
  if (EXCLUDED_FILE_SUFFIXES.some((suffix) => basename.endsWith(suffix))) {
    return false;
  }
  return !relativePath
    .split("/")
    .some((segment) => EXCLUDED_DIRECTORIES.has(segment));
}

async function collectSearchCandidateFiles(
  rootPath: string,
): Promise<string[]> {
  try {
    return await collectFilesWithRipgrep(rootPath);
  } catch (error) {
    if (shouldWarnRipgrepFailure(error)) {
      console.warn("[viewer-be] preview rg file search failed; falling back", {
        rootPath,
        error: describeRipgrepFailure(error),
      });
    }
    return (await collectFiles(rootPath)).filter(shouldIncludeFallbackFile);
  }
}
```

- [ ] **Step 2: Route `searchPreviewFiles` through candidate discovery**

Change this block:

```ts
const rootPath = await realpath(projectPath);
const rankedItems = await collectFiles(rootPath);
```

to:

```ts
const rootPath = await realpath(projectPath);
const rankedItems = await collectSearchCandidateFiles(rootPath);
```

- [ ] **Step 3: Run tests**

Run:

```bash
pnpm --filter @browser-viewer/backend exec vitest run src/terminal/preview-file-search.test.ts
```

Expected:

- `.gitignore` test passes if `rg` is available in the test environment.
- Env exclusion test passes.
- Ranking test may still fail; Task 4 handles ranking.

- [ ] **Step 4: Run existing route tests**

Run:

```bash
pnpm --filter @browser-viewer/backend exec vitest run src/routes/terminal.test.ts
```

Expected:

- Existing route tests pass.

## Task 3: Remove Legacy Session-Scoped Preview API

**Files:**

- Modify: `backend/src/routes/terminal.ts`
- Modify: `backend/src/routes/terminal.test.ts`
- Modify: `frontend/src/services/terminal.ts`
- Modify: `frontend/src/services/terminal.test.ts`

- [ ] **Step 1: Delete session Preview routes**

In `backend/src/routes/terminal.ts`, delete these route handlers:

```ts
router.get("/session/:id/preview/files/search", async (req, res) => {
  // delete entire handler
});

router.get("/session/:id/preview/file", async (req, res) => {
  // delete entire handler
});

router.get("/session/:id/preview/git-changes", async (req, res) => {
  // delete entire handler
});

router.get("/session/:id/preview/file-diff", async (req, res) => {
  // delete entire handler
});
```

Keep `resolvePreviewContext` only if another non-preview session route still needs it. If it becomes unused, delete it too.

- [ ] **Step 2: Delete legacy frontend service wrappers**

In `frontend/src/services/terminal.ts`, delete these exported functions:

```ts
export async function searchTerminalPreviewFiles(...) { ... }
export async function getTerminalPreviewFile(...) { ... }
export async function getTerminalPreviewGitChanges(...) { ... }
export async function getTerminalPreviewFileDiff(...) { ... }
```

Keep these project-scoped functions:

```ts
export async function searchTerminalProjectPreviewFiles(...) { ... }
export async function getTerminalProjectPreviewFile(...) { ... }
export async function getTerminalProjectPreviewGitChanges(...) { ... }
export async function getTerminalProjectPreviewFileDiff(...) { ... }
```

- [ ] **Step 3: Update tests to remove session Preview expectations**

In `backend/src/routes/terminal.test.ts`, delete existing test cases whose purpose is to verify `/api/terminal/session/:id/preview/...` behavior. Do not migrate those tests by replacing URLs. Session-scoped Preview is no longer part of the API surface.

Delete test cases that call any of these URL shapes:

```ts
/api/terminal/session/:id/preview/file
/api/terminal/session/:id/preview/files/search
/api/terminal/session/:id/preview/git-changes
/api/terminal/session/:id/preview/file-diff
```

Keep existing project-scoped tests and route-level tests that call these URL shapes:

```ts
/api/terminal/project/:id/preview/file
/api/terminal/project/:id/preview/files/search
/api/terminal/project/:id/preview/git-changes
/api/terminal/project/:id/preview/file-diff
```

If deleting a session-scoped test removes unique coverage, add a new project-scoped test from scratch with a fresh `state.projects` setup instead of mutating the old session test. The project-scoped test state must include:

```ts
projects: [
  {
    id: "project-default",
    name: "Default Project",
    path: projectPath,
    createdAt: new Date("2026-03-29T00:00:00.000Z"),
    isDefault: true,
  },
];
```

The request URL must use:

```ts
/api/terminal/project/project-default/preview/...
```

Do not rely on `current.projectId` or `resolvePreviewContext`; those exist only for terminal session behavior and are not involved in project-scoped Preview.

In `frontend/src/services/terminal.test.ts`, remove legacy session-scoped Preview service tests named:

```ts
"searches terminal preview files with encoded query and limit";
"loads a terminal preview file by encoded path";
"loads terminal preview changes and a selected file diff";
```

Keep and extend the project-scoped Preview service test. It should assert URLs under:

```ts
/api/terminal/project/project%2F1/preview/files/search
/api/terminal/project/project%2F1/preview/file
/api/terminal/project/project%2F1/preview/git-changes
/api/terminal/project/project%2F1/preview/file-diff
```

- [ ] **Step 4: Add explicit 404 regression for removed session Preview routes**

Add to `backend/src/routes/terminal.test.ts`:

```ts
it("does not expose legacy session-scoped preview routes", async () => {
  const projectPath = await mkdtemp(
    path.join(os.tmpdir(), "terminal-preview-"),
  );
  tempDirs.push(projectPath);
  await writeFile(path.join(projectPath, "README.md"), "# Preview\n");
  const state = {
    current: {
      id: "terminal-1",
      projectId: "project-default",
      name: "bash",
      command: "bash",
      args: [],
      cwd: projectPath,
      scrollback: "",
      status: "running" as const,
      createdAt: new Date("2026-03-29T00:00:00.000Z"),
    },
    projects: [
      {
        id: "project-default",
        name: "Default Project",
        path: projectPath,
        createdAt: new Date("2026-03-29T00:00:00.000Z"),
        isDefault: true,
      },
    ],
  };
  const { server } = createTestServer(state);
  servers.push(server);
  const port = await startServer(server);

  const response = await fetch(
    `http://127.0.0.1:${port}/api/terminal/session/terminal-1/preview/file?path=README.md`,
  );

  expect(response.status).toBe(404);
});
```

- [ ] **Step 5: Run route and service tests**

Run:

```bash
pnpm --filter @browser-viewer/backend exec vitest run src/routes/terminal.test.ts
pnpm --filter @browser-viewer/frontend exec vitest run src/services/terminal.test.ts
```

Expected:

- All tests pass.
- No frontend code imports the deleted session-scoped Preview service functions.

## Task 4: Improve Fuzzy Ranking for VS Code-Like Quick Open

**Files:**

- Modify: `backend/src/terminal/preview.ts`
- Test: `backend/src/terminal/preview-file-search.test.ts`

- [ ] **Step 1: Add VS Code-style query piece scoring**

VS Code's `prepareQuery(...)` splits only on spaces into multiple query values. Each query value must match, but each value still uses fuzzy, non-contiguous matching. This means:

- `tp` is one query piece and can match `terminal-preview.ts`.
- `terminal preview` is two query pieces and should not match `terminal-only.md`.
- Pieces may match the full relative path, not just the basename.

Replace `rankFile` with:

```ts
function splitQueryPieces(query: string): string[] {
  return query
    .trim()
    .split(/\s+/g)
    .map((piece) => piece.trim())
    .filter(Boolean);
}

function scoreQueryAgainstCandidate(query: string, candidate: string): number {
  const pieces = splitQueryPieces(query);
  if (pieces.length <= 1) {
    return fuzzyScore(query, candidate);
  }

  let total = 0;
  for (const piece of pieces) {
    const pieceScore = fuzzyScore(piece, candidate);
    if (pieceScore <= 0) {
      return 0;
    }
    total += pieceScore;
  }

  return total / pieces.length;
}

function pathBoundaryBonus(query: string, relativePath: string): number {
  const compactQuery = compactText(query);
  const compactPath = compactText(relativePath);
  if (!compactQuery) {
    return 0;
  }
  if (compactPath === compactQuery) {
    return 45;
  }
  if (compactPath.endsWith(compactQuery)) {
    return 30;
  }
  return 0;
}

function rankFile(
  query: string,
  relativePath: string,
): TerminalPreviewFileSearchItem | null {
  const basename = path.posix.basename(relativePath);
  const dirname = path.posix.dirname(relativePath);
  const normalizedDirname = dirname === "." ? "" : dirname;
  const basenameScore = scoreQueryAgainstCandidate(query, basename);
  const pathScore = scoreQueryAgainstCandidate(query, relativePath);
  const segmentScore = relativePath
    .split("/")
    .reduce(
      (best, segment) =>
        Math.max(best, scoreQueryAgainstCandidate(query, segment)),
      0,
    );
  const score = Math.max(
    basenameScore > 0 ? basenameScore + 25 : 0,
    pathScore > 0 ? pathScore + pathBoundaryBonus(query, relativePath) : 0,
    segmentScore > 0 ? segmentScore + 10 : 0,
  );
  if (score <= 0) {
    return null;
  }

  return {
    path: relativePath,
    basename,
    dirname: normalizedDirname,
    reason:
      basenameScore >= pathScore
        ? "basename fuzzy match"
        : "relative path fuzzy match",
    score: score - relativePath.length / 10_000,
  };
}
```

- [ ] **Step 2: Run direct search tests**

Run:

```bash
pnpm --filter @browser-viewer/backend exec vitest run src/terminal/preview-file-search.test.ts
```

Expected:

- All tests pass.

- [ ] **Step 3: Add query-piece regressions if missing**

If the ranking test from Task 1 did not fail before the implementation, add this test to `preview-file-search.test.ts`:

```ts
it("matches abbreviations as a single fuzzy query piece", async () => {
  const projectPath = await createProject();
  await mkdir(path.join(projectPath, "src"), { recursive: true });
  await writeFile(
    path.join(projectPath, "src/terminal-preview.ts"),
    "export {};\n",
  );

  const payload = await searchPreviewFiles({
    projectId: "project-1",
    projectPath,
    query: "tp",
    limit: 20,
  });

  expect(payload.items.map((item) => item.path)).toContain(
    "src/terminal-preview.ts",
  );
});

it("requires all space-separated query pieces to match", async () => {
  const projectPath = await createProject();
  await mkdir(path.join(projectPath, "docs"), { recursive: true });
  await writeFile(
    path.join(projectPath, "docs/terminal-preview-plan.md"),
    "# Plan\n",
  );
  await writeFile(path.join(projectPath, "terminal-only.md"), "# Terminal\n");
  await writeFile(path.join(projectPath, "preview-only.md"), "# Preview\n");

  const payload = await searchPreviewFiles({
    projectId: "project-1",
    projectPath,
    query: "terminal preview",
    limit: 20,
  });

  expect(payload.items.map((item) => item.path)).toContain(
    "docs/terminal-preview-plan.md",
  );
  expect(payload.items.map((item) => item.path)).not.toContain(
    "terminal-only.md",
  );
  expect(payload.items.map((item) => item.path)).not.toContain(
    "preview-only.md",
  );
});
```

Run:

```bash
pnpm --filter @browser-viewer/backend exec vitest run src/terminal/preview-file-search.test.ts
```

Expected:

- All tests pass.

## Task 5: Add Short-Lived Project Candidate Cache

**Files:**

- Modify: `backend/src/terminal/preview.ts`
- Test: `backend/src/terminal/preview-file-search.test.ts`

- [ ] **Step 1: Add cache constants and helpers**

Add near search constants:

```ts
const FILE_SEARCH_CACHE_TTL_MS = 15_000;

interface FileSearchCacheEntry {
  loadedAt: number;
  files: string[];
}

const fileSearchCandidateCache = new Map<string, FileSearchCacheEntry>();
const fileSearchCandidateInflight = new Map<string, Promise<string[]>>();
```

Add helper functions:

```ts
function getFileSearchCacheKey(projectId: string, rootPath: string): string {
  return `${projectId}:${rootPath}`;
}

function readFileSearchCache(
  cacheKey: string,
  now = Date.now(),
): string[] | null {
  const cached = fileSearchCandidateCache.get(cacheKey);
  if (!cached) {
    return null;
  }
  if (now - cached.loadedAt > FILE_SEARCH_CACHE_TTL_MS) {
    fileSearchCandidateCache.delete(cacheKey);
    return null;
  }
  return cached.files;
}

function writeFileSearchCache(
  cacheKey: string,
  files: string[],
  now = Date.now(),
): void {
  fileSearchCandidateCache.set(cacheKey, {
    loadedAt: now,
    files,
  });
}

export function clearPreviewFileSearchCache(projectId?: string): void {
  if (!projectId) {
    fileSearchCandidateCache.clear();
    fileSearchCandidateInflight.clear();
    return;
  }

  for (const cacheKey of fileSearchCandidateCache.keys()) {
    if (cacheKey.startsWith(`${projectId}:`)) {
      fileSearchCandidateCache.delete(cacheKey);
    }
  }
  for (const cacheKey of fileSearchCandidateInflight.keys()) {
    if (cacheKey.startsWith(`${projectId}:`)) {
      fileSearchCandidateInflight.delete(cacheKey);
    }
  }
}

async function collectCachedSearchCandidateFiles(
  projectId: string,
  rootPath: string,
): Promise<string[]> {
  const cacheKey = getFileSearchCacheKey(projectId, rootPath);
  const cached = readFileSearchCache(cacheKey);
  if (cached) {
    return cached;
  }

  const inflight = fileSearchCandidateInflight.get(cacheKey);
  if (inflight) {
    return inflight;
  }

  const pending = collectSearchCandidateFiles(rootPath)
    .then((files) => {
      writeFileSearchCache(cacheKey, files);
      return files;
    })
    .finally(() => {
      fileSearchCandidateInflight.delete(cacheKey);
    });
  fileSearchCandidateInflight.set(cacheKey, pending);
  return pending;
}
```

- [ ] **Step 2: Use cache in `searchPreviewFiles`**

Change:

```ts
const rankedItems = await collectSearchCandidateFiles(rootPath);
```

to:

```ts
const rankedItems = await collectCachedSearchCandidateFiles(
  params.projectId,
  rootPath,
);
```

- [ ] **Step 3: Add cache invalidation on project path update and delete**

Modify `backend/src/routes/terminal.ts` imports:

```ts
  clearPreviewFileSearchCache,
```

from `../terminal/preview`.

In `router.patch("/project/:id", ...)`, after a successful update and before `res.json(...)`, add:

```ts
clearPreviewFileSearchCache(project.id);
```

In `router.delete("/project/:id", ...)`, after successful delete, add:

```ts
clearPreviewFileSearchCache(req.params.id);
```

- [ ] **Step 4: Add cache test**

Add to `backend/src/terminal/preview-file-search.test.ts`:

```ts
import { clearPreviewFileSearchCache } from "./preview";
```

Update `afterEach`:

```ts
clearPreviewFileSearchCache();
```

Add test:

```ts
it("reuses cached candidate files for repeated project searches", async () => {
  const projectPath = await createProject();
  await writeFile(path.join(projectPath, "first-preview.md"), "# First\n");

  const first = await searchPreviewFiles({
    projectId: "project-1",
    projectPath,
    query: "preview",
    limit: 20,
  });
  expect(first.items.map((item) => item.path)).toContain("first-preview.md");

  await writeFile(path.join(projectPath, "second-preview.md"), "# Second\n");

  const second = await searchPreviewFiles({
    projectId: "project-1",
    projectPath,
    query: "preview",
    limit: 20,
  });
  expect(second.items.map((item) => item.path)).toContain("first-preview.md");
  expect(second.items.map((item) => item.path)).not.toContain(
    "second-preview.md",
  );

  clearPreviewFileSearchCache("project-1");

  const afterClear = await searchPreviewFiles({
    projectId: "project-1",
    projectPath,
    query: "preview",
    limit: 20,
  });
  expect(afterClear.items.map((item) => item.path)).toContain(
    "second-preview.md",
  );
});
```

Do not add a production-only injection seam just to count `rg` invocations. The implementation requirement is the `fileSearchCandidateInflight` map above: on cache miss, check the inflight map before starting discovery, and clear it in `finally`.

- [ ] **Step 5: Review concurrent miss behavior**

Before running tests, inspect `collectCachedSearchCandidateFiles` and confirm this exact ordering:

1. Read completed cache.
2. Read `fileSearchCandidateInflight`.
3. If inflight exists, return the existing promise.
4. If not, create one `collectSearchCandidateFiles(rootPath)` promise.
5. Store the promise in `fileSearchCandidateInflight` before awaiting it.
6. Write completed cache in `.then(...)`.
7. Delete inflight entry in `.finally(...)`.

This prevents a burst of Preview requests from spawning multiple `rg --files` processes for the same project/root.

- [ ] **Step 6: Run tests**

Run:

```bash
pnpm --filter @browser-viewer/backend exec vitest run src/terminal/preview-file-search.test.ts src/routes/terminal.test.ts
```

Expected:

- All tests pass.

## Task 6: Add Route-Level Ignore Regression

**Files:**

- Modify: `backend/src/routes/terminal.test.ts`

- [ ] **Step 1: Add project route test**

Add near existing Preview route tests:

```ts
it("searches project preview files without returning gitignored files", async () => {
  const projectPath = await mkdtemp(
    path.join(os.tmpdir(), "terminal-preview-"),
  );
  tempDirs.push(projectPath);
  await mkdir(path.join(projectPath, "src"), { recursive: true });
  await mkdir(path.join(projectPath, "dist"), { recursive: true });
  await writeFile(path.join(projectPath, ".gitignore"), "dist/\n");
  await writeFile(
    path.join(projectPath, "src/terminal-preview.ts"),
    "export {};\n",
  );
  await writeFile(
    path.join(projectPath, "dist/terminal-preview.js"),
    "ignored\n",
  );
  const state = {
    current: null,
    projects: [
      {
        id: "project-default",
        name: "Default Project",
        path: projectPath,
        createdAt: new Date("2026-03-29T00:00:00.000Z"),
        isDefault: true,
      },
    ],
  };
  const { server } = createTestServer(state);
  servers.push(server);
  const port = await startServer(server);

  const response = await fetch(
    `http://127.0.0.1:${port}/api/terminal/project/project-default/preview/files/search?q=terminal%20preview&limit=20`,
  );

  expect(response.status).toBe(200);
  const payload = (await response.json()) as {
    items: Array<{ path: string }>;
  };
  expect(payload.items.map((item) => item.path)).toContain(
    "src/terminal-preview.ts",
  );
  expect(payload.items.map((item) => item.path)).not.toContain(
    "dist/terminal-preview.js",
  );
});
```

- [ ] **Step 2: Run route tests**

Run:

```bash
pnpm --filter @browser-viewer/backend exec vitest run src/routes/terminal.test.ts
```

Expected:

- All route tests pass.

## Task 7: Add Preview E2E Regression

**Files:**

- Modify: `frontend/tests/terminal-preview.spec.ts`

- [ ] **Step 1: Seed ignored file in E2E repo**

In `createPreviewRepo`, after creating `docs/architecture`, add:

```ts
await mkdir(path.join(repo, "dist"), { recursive: true });
await writeFile(path.join(repo, ".gitignore"), "dist/\n");
await writeFile(path.join(repo, "dist/terminal-code-preview.js"), "ignored\n");
```

- [ ] **Step 2: Add assertion after search results open**

After filling `"terminal preview"` and before clicking `terminal-code-preview.md`, add:

```ts
await expect(page.getByText("dist/terminal-code-preview.js")).not.toBeVisible();
```

Keep the existing click:

```ts
await page.getByText("terminal-code-preview.md").click();
```

- [ ] **Step 3: Run E2E**

Run:

```bash
pnpm --filter @browser-viewer/frontend exec playwright test tests/terminal-preview.spec.ts
```

Expected:

- The Preview E2E passes.

## Task 8: Full Verification

**Files:**

- No file edits.

- [ ] **Step 1: Run backend focused tests**

Run:

```bash
pnpm --filter @browser-viewer/backend exec vitest run src/terminal/preview-file-search.test.ts src/routes/terminal.test.ts
```

Expected:

- All listed tests pass.

- [ ] **Step 2: Run frontend Preview E2E**

Run:

```bash
pnpm --filter @browser-viewer/frontend exec playwright test tests/terminal-preview.spec.ts
```

Expected:

- The Preview E2E passes.

- [ ] **Step 3: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected:

- `packages/shared`, `backend`, `frontend`, and `electron` typecheck pass.

- [ ] **Step 4: Run lint**

Run:

```bash
pnpm lint
```

Expected:

- All workspace lint tasks pass.

- [ ] **Step 5: Commit**

Run:

```bash
git add backend/src/terminal/preview.ts backend/src/terminal/preview-file-search.test.ts backend/src/routes/terminal.ts backend/src/routes/terminal.test.ts frontend/src/services/terminal.ts frontend/src/services/terminal.test.ts frontend/tests/terminal-preview.spec.ts
git commit -m "Improve preview file search"
```

Expected:

- Commit succeeds after lint-staged.

## Risks and Constraints

- `rg` may not be present in some backend runtime environments. The fallback scan keeps Preview usable, but production packaging should verify whether `rg` is available wherever Runweave backend runs.
- `rg --files --hidden` can include hidden files. Keep the VS Code-inspired baseline excludes current, and require explicit review before adding broad dot-directory excludes such as `.vscode`, `.github`, or `.husky`.
- Respecting `.gitignore` can hide generated files users sometimes want to preview. This matches VS Code default behavior; a later setting can add "include ignored files" if needed.
- Cache TTL can briefly hide newly created files from search. Manual refresh or project edit invalidates cache; a later file watcher can make this instant.

## Self-Review

- Spec coverage:
  - VS Code-style `rg --files`: Task 2.
  - Ignore behavior: Tasks 1, 2, 6, 7.
  - Legacy session Preview API removal: Task 3.
  - Better ranking: Task 4.
  - Candidate cache: Task 5.
  - End-to-end regression: Task 7.
  - Full validation: Task 8.

- Placeholder scan:
  - No `TBD`, `TODO`, or "implement later" placeholders.
  - Each code-changing step includes concrete code or exact edit instructions.

- Type consistency:
  - Public API remains `searchPreviewFiles`.
  - New cache export is `clearPreviewFileSearchCache`.
  - Existing response types remain unchanged.
