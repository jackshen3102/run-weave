# Preview Code Save Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit save flow for editable text/code files opened in Terminal Preview.

**Architecture:** Keep Preview project-scoped and path-confined to the active Terminal Project path. Add a dedicated file-save API next to the existing project Preview read API, then make the Monaco file viewer optionally editable only for `file` mode text-like files. Preserve read-only behavior for Changes, image previews, SVG preview mode, oversized files, binary files, and projects without a path.

**Tech Stack:** Node.js, Express, TypeScript, React/Vite, Monaco Editor, Zustand, Vitest, Playwright.

---

## Current Code Facts

- Shared Preview protocol lives in `packages/shared/src/terminal-protocol.ts`. Existing file and diff responses include `readonly: true`.
- Backend Preview logic lives in `backend/src/terminal/preview.ts`. It already has project-path validation through `ensureProjectPath(...)` and `resolvePreviewPath(...)`.
- Backend Preview routes live in `backend/src/routes/terminal.ts`. Existing routes are project-scoped:
  - `GET /api/terminal/project/:id/preview/files/search`
  - `GET /api/terminal/project/:id/preview/file`
  - `GET /api/terminal/project/:id/preview/asset`
  - `GET /api/terminal/project/:id/preview/git-changes`
  - `GET /api/terminal/project/:id/preview/file-diff`
- Frontend API wrappers live in `frontend/src/services/terminal.ts`.
- Terminal Preview state lives in `frontend/src/features/terminal/preview-store.ts`, keyed by project ID.
- `frontend/src/components/terminal/terminal-preview-panel.tsx` owns file loading, refresh, selected path state, and mode-specific actions.
- `frontend/src/components/terminal/terminal-monaco-viewer.tsx` wraps Monaco, and currently hardcodes `readOnly: true`.
- `docs/architecture/terminal-code-preview.md` originally scoped Preview as read-only and explicitly listed code editing/saving as a non-goal. This feature intentionally changes that boundary for text/code files only.

## Product Decisions

- v1 supports saving only existing text-like files opened through `file` mode.
- v1 does not create new files, rename files, delete files, stage changes, commit changes, or save images/binary assets.
- v1 does not make `changes` mode editable. Diff remains read-only.
- Markdown `Source` and `Split` source panes can be editable; rendered Markdown preview remains display-only.
- SVG `Source` can be editable; SVG `Preview` remains display-only.
- Image files remain preview-only.
- Save is explicit: user edits, Preview shows dirty state, then user clicks `Save` or presses `Cmd/Ctrl+S`.
- Refresh with unsaved edits should ask for confirmation before discarding local edits.
- Opening another file with unsaved edits should ask for confirmation before discarding local edits.
- Close Preview with unsaved edits should ask for confirmation before closing.
- Conflict handling is mtime-based in v1: if the file changed on disk since it was loaded, save returns conflict and the UI asks the user to reload or overwrite.

## File Structure

- Modify `packages/shared/src/terminal-protocol.ts`
  - Add `TerminalPreviewSaveFileRequest`.
  - Add `TerminalPreviewSaveFileResponse`.
  - Add `mtimeMs` to `TerminalPreviewFileResponse`.
- Modify `backend/src/terminal/preview.ts`
  - Add `savePreviewFile(...)`.
  - Reuse path confinement and text/binary checks.
  - Reject directories, binary files, oversized content, and mtime conflicts.
- Create `backend/src/terminal/preview-save.test.ts`
  - Direct unit tests for saving, path confinement, binary rejection, and mtime conflict.
- Modify `backend/src/routes/terminal.ts`
  - Add request schema and `PUT /api/terminal/project/:id/preview/file`.
  - Clear project file-search cache after a successful save.
- Modify `backend/src/routes/terminal.test.ts`
  - Add route-level coverage for successful save and conflict.
- Modify `frontend/src/services/terminal.ts`
  - Add `saveTerminalProjectPreviewFile(...)`.
- Modify `frontend/src/services/terminal.test.ts`
  - Add URL/method/body coverage for save wrapper.
- Modify `frontend/src/components/terminal/terminal-monaco-viewer.tsx`
  - Add optional editable mode and `onContentChange`.
  - Keep diff editor read-only.
- Modify `frontend/src/components/terminal/terminal-preview-panel.tsx`
  - Track editable content, dirty state, save status, loaded mtime, and conflict UI.
  - Wire `Save` button and `Cmd/Ctrl+S`.
  - Guard refresh/open-another/close when dirty.
- Modify `frontend/src/features/terminal/preview-store.ts`
  - No global persisted draft state in v1. Store remains selection/layout only.
- Modify `frontend/tests/terminal-preview.spec.ts`
  - Add E2E for opening a file, editing it, saving it, and verifying disk content through terminal or backend read.

## API Contract

### Shared Types

```ts
export interface TerminalPreviewFileResponse {
  kind: "file";
  projectId: string;
  path: string;
  absolutePath: string;
  base: "project";
  projectPath: string;
  language: string;
  content: string;
  sizeBytes: number;
  mtimeMs: number;
  readonly: boolean;
}

export interface TerminalPreviewSaveFileRequest {
  path: string;
  content: string;
  expectedMtimeMs?: number;
  overwrite?: boolean;
}

export interface TerminalPreviewSaveFileResponse {
  kind: "file";
  projectId: string;
  path: string;
  absolutePath: string;
  base: "project";
  projectPath: string;
  language: string;
  content: string;
  sizeBytes: number;
  mtimeMs: number;
  readonly: false;
}
```

### Route

```text
PUT /api/terminal/project/:id/preview/file
Content-Type: application/json

{
  "path": "src/App.tsx",
  "content": "...",
  "expectedMtimeMs": 1713520000000.123,
  "overwrite": false
}
```

Responses:

- `200`: saved file payload with updated `mtimeMs`.
- `400`: invalid body, empty path, directory path, unsupported home path.
- `403`: resolved path outside project root.
- `404`: file no longer exists.
- `409`: file changed on disk since loaded.
- `413`: saved content exceeds save limit.
- `415`: target is binary or content is not valid UTF-8 text.

## Backend Rules

- Use project path, not terminal session cwd.
- Reuse `resolvePreviewPath(projectPath, requestedPath)` so symlinks cannot escape project root.
- Read target `stat` before write:
  - reject missing file with `404`
  - reject directories with `400`
  - reject non-regular files with `400`
  - reject files larger than the existing preview limit before reading
- Read existing file before write and reject if it is binary.
- Convert incoming content to `Buffer.from(content, "utf8")`.
- Reject if content byte length exceeds `FILE_PREVIEW_MAX_BYTES`.
- If `expectedMtimeMs` is provided and `overwrite !== true`, compare it to current `stat.mtimeMs` with a small tolerance.
- Write with `writeFile(absolutePath, buffer)`.
- Re-stat after write and return `mtimeMs`, `sizeBytes`, `language`, and saved `content`.
- Clear Preview file search cache for the project after successful save, because saved content may create/delete searchable generated files in later versions. The cost is small and the behavior is predictable.

## Frontend State Model

In `TerminalPreviewPanel`, keep draft state local to the currently opened file:

```ts
const [editorContent, setEditorContent] = useState("");
const [loadedContent, setLoadedContent] = useState("");
const [loadedMtimeMs, setLoadedMtimeMs] = useState<number | null>(null);
const [saveLoading, setSaveLoading] = useState(false);
const [saveError, setSaveError] = useState<string | null>(null);
const [saveConflict, setSaveConflict] = useState(false);

const dirty = editorContent !== loadedContent;
```

When `loadFile(...)` succeeds:

```ts
setFilePreview(payload);
setEditorContent(payload.content);
setLoadedContent(payload.content);
setLoadedMtimeMs(payload.mtimeMs);
setSaveError(null);
setSaveConflict(false);
```

When save succeeds:

```ts
setFilePreview(payload);
setEditorContent(payload.content);
setLoadedContent(payload.content);
setLoadedMtimeMs(payload.mtimeMs);
setSaveError(null);
setSaveConflict(false);
```

## Editable Surface

Update `TerminalMonacoViewer` props:

```ts
interface TerminalMonacoViewerProps {
  language?: string;
  content?: string;
  oldContent?: string;
  newContent?: string;
  diff?: boolean;
  editable?: boolean;
  scrollRatio?: number;
  onContentChange?: (content: string) => void;
  onScrollRatioChange?: (ratio: number) => void;
}
```

Editor options:

```ts
const editorOptions = {
  ...EDITOR_OPTIONS,
  readOnly: !editable,
};
```

Editor usage:

```tsx
<Editor
  height="100%"
  language={language}
  value={content}
  theme="vs-dark"
  options={editorOptions}
  onChange={(value) => {
    if (editable) {
      onContentChange?.(value ?? "");
    }
  }}
/>
```

Diff editor keeps:

```ts
originalEditable: false,
readOnly: true,
```

## Task 1: Backend Save Unit Tests

**Files:**

- Create: `backend/src/terminal/preview-save.test.ts`
- Modify: none

- [ ] **Step 1: Write failing tests**

Create `backend/src/terminal/preview-save.test.ts`:

```ts
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { savePreviewFile, TerminalPreviewError } from "./preview";

const tempDirs: string[] = [];

async function createProject(): Promise<string> {
  const projectPath = await mkdtemp(path.join(os.tmpdir(), "preview-save-"));
  tempDirs.push(projectPath);
  return projectPath;
}

describe("preview file saving", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
    tempDirs.length = 0;
  });

  it("saves an existing text file inside the project path", async () => {
    const projectPath = await createProject();
    await mkdir(path.join(projectPath, "src"), { recursive: true });
    const filePath = path.join(projectPath, "src/App.ts");
    await writeFile(filePath, "export const value = 1;\n");
    const before = await stat(filePath);

    const payload = await savePreviewFile({
      projectId: "project-1",
      projectPath,
      requestedPath: "src/App.ts",
      content: "export const value = 2;\n",
      expectedMtimeMs: before.mtimeMs,
    });

    expect(payload.kind).toBe("file");
    expect(payload.path).toBe("src/App.ts");
    expect(payload.content).toBe("export const value = 2;\n");
    expect(payload.readonly).toBe(false);
    await expect(readFile(filePath, "utf8")).resolves.toBe(
      "export const value = 2;\n",
    );
  });

  it("rejects saves outside the project path", async () => {
    const projectPath = await createProject();
    const outsidePath = await createProject();
    const outsideFile = path.join(outsidePath, "secret.ts");
    await writeFile(outsideFile, "secret\n");

    await expect(
      savePreviewFile({
        projectId: "project-1",
        projectPath,
        requestedPath: outsideFile,
        content: "changed\n",
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
    } satisfies Partial<TerminalPreviewError>);
  });

  it("rejects symlinks that resolve outside the project path", async () => {
    const projectPath = await createProject();
    const outsidePath = await createProject();
    const outsideFile = path.join(outsidePath, "secret.ts");
    await writeFile(outsideFile, "secret\n");
    await symlink(outsideFile, path.join(projectPath, "linked-secret.ts"));

    await expect(
      savePreviewFile({
        projectId: "project-1",
        projectPath,
        requestedPath: "linked-secret.ts",
        content: "changed\n",
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
    } satisfies Partial<TerminalPreviewError>);
  });

  it("rejects mtime conflicts unless overwrite is true", async () => {
    const projectPath = await createProject();
    const filePath = path.join(projectPath, "README.md");
    await writeFile(filePath, "first\n");
    const before = await stat(filePath);
    await writeFile(filePath, "second\n");

    await expect(
      savePreviewFile({
        projectId: "project-1",
        projectPath,
        requestedPath: "README.md",
        content: "third\n",
        expectedMtimeMs: before.mtimeMs,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
    } satisfies Partial<TerminalPreviewError>);

    const payload = await savePreviewFile({
      projectId: "project-1",
      projectPath,
      requestedPath: "README.md",
      content: "third\n",
      expectedMtimeMs: before.mtimeMs,
      overwrite: true,
    });
    expect(payload.content).toBe("third\n");
  });

  it("rejects binary target files", async () => {
    const projectPath = await createProject();
    await writeFile(
      path.join(projectPath, "image.bin"),
      Buffer.from([0, 1, 2, 3]),
    );

    await expect(
      savePreviewFile({
        projectId: "project-1",
        projectPath,
        requestedPath: "image.bin",
        content: "not binary anymore\n",
      }),
    ).rejects.toMatchObject({
      statusCode: 415,
    } satisfies Partial<TerminalPreviewError>);
  });
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
pnpm --filter ./backend test -- src/terminal/preview-save.test.ts
```

Expected: fails because `savePreviewFile` is not exported.

## Task 2: Backend Save Implementation

**Files:**

- Modify: `backend/src/terminal/preview.ts`
- Test: `backend/src/terminal/preview-save.test.ts`

- [ ] **Step 1: Add response typing and filesystem imports**

Add `TerminalPreviewSaveFileResponse` to the existing import from `@browser-viewer/shared`.
Add `writeFile` to the existing `node:fs/promises` import.

- [ ] **Step 2: Return `mtimeMs` from read API**

In `readPreviewFile(...)`, add:

```ts
mtimeMs: fileStats.mtimeMs,
```

- [ ] **Step 3: Add save function**

Add below `readPreviewFile(...)`:

```ts
const MTIME_CONFLICT_TOLERANCE_MS = 2;

export async function savePreviewFile(params: {
  projectId: string;
  projectPath: string | null | undefined;
  requestedPath: string;
  content: string;
  expectedMtimeMs?: number;
  overwrite?: boolean;
}): Promise<TerminalPreviewSaveFileResponse> {
  const projectPath = ensureProjectPath(params.projectPath);
  const { absolutePath, relativePath } = await resolvePreviewPath(
    projectPath,
    params.requestedPath,
  );
  const fileStats = await stat(absolutePath).catch(() => null);
  if (!fileStats) {
    throw new TerminalPreviewError("File not found", 404);
  }
  if (fileStats.isDirectory()) {
    throw new TerminalPreviewError("Directories are not supported", 400);
  }
  if (!fileStats.isFile()) {
    throw new TerminalPreviewError("Only regular files can be saved", 400);
  }
  if (fileStats.size > FILE_PREVIEW_MAX_BYTES) {
    throw new TerminalPreviewError("File exceeds preview limit", 413);
  }
  if (
    params.expectedMtimeMs !== undefined &&
    !params.overwrite &&
    Math.abs(fileStats.mtimeMs - params.expectedMtimeMs) >
      MTIME_CONFLICT_TOLERANCE_MS
  ) {
    throw new TerminalPreviewError("File changed on disk", 409);
  }

  const existingContent = await readFile(absolutePath);
  if (isLikelyBinary(existingContent)) {
    throw new TerminalPreviewError("Binary files cannot be saved", 415);
  }

  const nextContent = Buffer.from(params.content, "utf8");
  if (nextContent.byteLength > FILE_PREVIEW_MAX_BYTES) {
    throw new TerminalPreviewError("File exceeds preview limit", 413);
  }

  await writeFile(absolutePath, nextContent);
  const nextStats = await stat(absolutePath);

  return {
    kind: "file",
    projectId: params.projectId,
    path: relativePath,
    absolutePath,
    base: "project",
    projectPath,
    language: detectLanguage(relativePath),
    content: params.content,
    sizeBytes: nextStats.size,
    mtimeMs: nextStats.mtimeMs,
    readonly: false,
  };
}
```

- [ ] **Step 4: Run backend save tests**

Run:

```bash
pnpm --filter ./backend test -- src/terminal/preview-save.test.ts
```

Expected: pass.

## Task 3: Shared Protocol and Route

**Files:**

- Modify: `packages/shared/src/terminal-protocol.ts`
- Modify: `backend/src/routes/terminal.ts`
- Modify: `backend/src/routes/terminal.test.ts`
- Test: `packages/shared/src/contracts.test.ts`, `backend/src/routes/terminal.test.ts`

- [ ] **Step 1: Add shared request and response types**

Add the shared types from the API Contract section to `packages/shared/src/terminal-protocol.ts`.

- [ ] **Step 2: Add route schema**

In `backend/src/routes/terminal.ts`, add:

```ts
const savePreviewFileSchema = z
  .object({
    path: z.string().min(1),
    content: z.string(),
    expectedMtimeMs: z.number().finite().optional(),
    overwrite: z.boolean().optional(),
  })
  .strict();
```

- [ ] **Step 3: Import `savePreviewFile`**

Add `savePreviewFile` to the import from `../terminal/preview`.

- [ ] **Step 4: Add route**

Place after the existing `GET /project/:id/preview/file` route:

```ts
router.put("/project/:id/preview/file", async (req, res) => {
  const parsed = savePreviewFileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      message: "Invalid request body",
      errors: parsed.error.flatten(),
    });
    return;
  }

  try {
    const { project } = resolveProjectPreviewContext(req.params.id);
    const payload = await savePreviewFile({
      projectId: project.id,
      projectPath: project.path,
      requestedPath: parsed.data.path,
      content: parsed.data.content,
      expectedMtimeMs: parsed.data.expectedMtimeMs,
      overwrite: parsed.data.overwrite,
    });
    clearPreviewFileSearchCache(project.id);
    res.json(payload);
  } catch (error) {
    handlePreviewError(res, error);
  }
});
```

- [ ] **Step 5: Add route tests**

In `backend/src/routes/terminal.test.ts`, add one test for successful save and one test for `409` conflict using the existing terminal route test helpers.

- [ ] **Step 6: Run route and shared tests**

Run:

```bash
pnpm --filter ./backend test -- src/routes/terminal.test.ts
pnpm --filter ./packages/shared test -- src/contracts.test.ts
```

Expected: pass.

## Task 4: Frontend Service Wrapper

**Files:**

- Modify: `frontend/src/services/terminal.ts`
- Modify: `frontend/src/services/terminal.test.ts`

- [ ] **Step 1: Import shared save types**

Add `TerminalPreviewSaveFileRequest` and `TerminalPreviewSaveFileResponse` to the shared import.

- [ ] **Step 2: Add wrapper**

Add:

```ts
export async function saveTerminalProjectPreviewFile(
  apiBase: string,
  token: string,
  projectId: string,
  payload: TerminalPreviewSaveFileRequest,
): Promise<TerminalPreviewSaveFileResponse> {
  return requestJson<TerminalPreviewSaveFileResponse>(
    apiBase,
    `/api/terminal/project/${encodeURIComponent(projectId)}/preview/file`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    },
  );
}
```

- [ ] **Step 3: Add service test**

In `frontend/src/services/terminal.test.ts`, assert that the wrapper calls:

```text
PUT http://localhost:5001/api/terminal/project/project%2F1/preview/file
```

with body:

```json
{
  "path": "src/App.tsx",
  "content": "export {};\n",
  "expectedMtimeMs": 1713520000000
}
```

- [ ] **Step 4: Run service tests**

Run:

```bash
pnpm --filter ./frontend test -- src/services/terminal.test.ts
```

Expected: pass.

## Task 5: Editable Monaco Viewer

**Files:**

- Modify: `frontend/src/components/terminal/terminal-monaco-viewer.tsx`

- [ ] **Step 1: Add editable props**

Use the `TerminalMonacoViewerProps` shape from the Editable Surface section.

- [ ] **Step 2: Keep diff read-only**

Do not pass `editable` to `DiffEditor`. Keep `readOnly: true` and `originalEditable: false`.

- [ ] **Step 3: Wire `Editor.onChange`**

For the normal editor, pass `readOnly: !editable` and call `onContentChange?.(value ?? "")` only when editable is true.

- [ ] **Step 4: Typecheck frontend**

Run:

```bash
pnpm --filter ./frontend typecheck
```

Expected: pass.

## Task 6: Preview Panel Save UI

**Files:**

- Modify: `frontend/src/components/terminal/terminal-preview-panel.tsx`

- [ ] **Step 1: Import save icon and service**

Add `Save` from `lucide-react` and `saveTerminalProjectPreviewFile` from `../../services/terminal`.

- [ ] **Step 2: Add local draft state**

Add the Frontend State Model state variables near existing `filePreview` state.

- [ ] **Step 3: Populate draft on load**

In `loadFile(...)` success branch, set editor content, loaded content, and `loadedMtimeMs` from the payload.

- [ ] **Step 4: Add save callback**

Add:

```ts
const saveFile = useCallback(
  async (options?: { overwrite?: boolean }): Promise<void> => {
    if (!projectId || !selectedFilePath || fileKind === "image") {
      return;
    }
    setSaveLoading(true);
    setSaveError(null);
    setSaveConflict(false);
    try {
      const payload = await saveTerminalProjectPreviewFile(
        apiBase,
        token,
        projectId,
        {
          path: selectedFilePath,
          content: editorContent,
          expectedMtimeMs: loadedMtimeMs ?? undefined,
          overwrite: options?.overwrite,
        },
      );
      setFilePreview(payload);
      setEditorContent(payload.content);
      setLoadedContent(payload.content);
      setLoadedMtimeMs(payload.mtimeMs);
    } catch (error) {
      if (error instanceof HttpError && error.status === 409) {
        setSaveConflict(true);
      }
      setSaveError(handleRequestError(error));
    } finally {
      setSaveLoading(false);
    }
  },
  [
    apiBase,
    editorContent,
    fileKind,
    handleRequestError,
    loadedMtimeMs,
    projectId,
    selectedFilePath,
    token,
  ],
);
```

- [ ] **Step 5: Add keyboard shortcut**

Add an effect:

```ts
useEffect(() => {
  if (mode !== "file" || !dirty) {
    return;
  }
  const handleKeyDown = (event: KeyboardEvent): void => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void saveFile();
    }
  };
  window.addEventListener("keydown", handleKeyDown);
  return () => window.removeEventListener("keydown", handleKeyDown);
}, [dirty, mode, saveFile]);
```

- [ ] **Step 6: Make file editors editable**

Use `editorContent` for editable source views:

```tsx
<TerminalMonacoViewer
  language={monacoLanguage}
  content={editorContent}
  editable
  onContentChange={setEditorContent}
/>
```

Apply this to text/code, Markdown source pane, Markdown split source pane, and SVG source pane.

- [ ] **Step 7: Add Save button**

In the header action group, before Refresh:

```tsx
<Button
  type="button"
  size="sm"
  variant={dirty ? "secondary" : "ghost"}
  className="h-8 rounded-lg px-2"
  disabled={
    mode !== "file" ||
    !selectedFilePath ||
    fileKind === "image" ||
    saveLoading ||
    !dirty
  }
  onClick={() => void saveFile()}
  aria-label="Save file"
>
  <Save className="h-4 w-4" />
</Button>
```

- [ ] **Step 8: Show dirty and error state**

Next to the current `Read only` badge, replace with:

```tsx
<span className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] uppercase text-slate-400">
  {mode === "file" && selectedFilePath && fileKind !== "image"
    ? "Editable"
    : "Read only"}
</span>;
{
  dirty ? (
    <span className="rounded border border-amber-500/60 px-1.5 py-0.5 text-[10px] uppercase text-amber-200">
      Unsaved
    </span>
  ) : null;
}
```

Render `saveError` under the path bar when present. If `saveConflict` is true, show `Reload` and `Overwrite` buttons.

- [ ] **Step 9: Guard destructive navigation**

Before `refresh`, `openFilePath`, `Open another...`, and `closePreview`, call a small local helper:

```ts
const confirmDiscardUnsaved = (): boolean => {
  if (!dirty) {
    return true;
  }
  return window.confirm("Discard unsaved changes?");
};
```

Use it to prevent accidental loss in v1.

- [ ] **Step 10: Run frontend typecheck**

Run:

```bash
pnpm --filter ./frontend typecheck
```

Expected: pass.

## Task 7: E2E Coverage

**Files:**

- Modify: `frontend/tests/terminal-preview.spec.ts`

- [ ] **Step 1: Add save scenario**

Add a Playwright test that:

1. Creates or uses a temp project path.
2. Opens Preview.
3. Searches for a text file.
4. Opens it.
5. Edits content in Monaco.
6. Clicks Save.
7. Refreshes/reopens the file and verifies the saved content is still present.

- [ ] **Step 2: Run E2E test**

Run:

```bash
pnpm --filter ./frontend e2e -- terminal-preview.spec.ts
```

Expected: pass.

## Task 8: Documentation Update

**Files:**

- Modify: `docs/architecture/terminal-code-preview.md`

- [ ] **Step 1: Update product boundary**

Change the non-goal line:

```md
- 不做代码编辑、保存、重命名、删除。
```

to:

```md
- v1 仅支持已打开文本/代码文件的显式编辑保存；不做新建、重命名、删除、stage、commit 或完整 IDE 能力。
```

- [ ] **Step 2: Add save behavior note**

Add a short section:

```md
### 代码保存

Terminal Preview 的保存能力仅作用于当前 Terminal Project 路径内已打开的文本/代码文件。保存是显式操作，支持 `Cmd/Ctrl+S` 和 Header 的 `Save` 按钮。图片、二进制文件和 Changes diff 保持只读。若文件在打开后被外部进程修改，保存接口返回冲突，由用户选择重新加载或覆盖。
```

## Verification

Run:

```bash
pnpm --filter ./packages/shared test -- src/contracts.test.ts
pnpm --filter ./backend test -- src/terminal/preview-save.test.ts src/routes/terminal.test.ts
pnpm --filter ./frontend test -- src/services/terminal.test.ts
pnpm --filter ./frontend typecheck
pnpm --filter ./frontend e2e -- terminal-preview.spec.ts
```

Expected: all pass.

For a broader pre-merge check, run:

```bash
pnpm typecheck
pnpm test
```

## Open Questions

- Should save be enabled for Markdown rendered `Preview` mode via a hidden source model, or only when a source editor is visible? Recommendation: allow saving if the file has an editor draft, but keep edits only possible through source panes.
- Should conflicts offer a side-by-side diff in v1? Recommendation: no. Start with `Reload` and `Overwrite`; diff conflict UI can be a follow-up.
- Should code save be disabled in web client mode and only enabled in Electron/local mode? Recommendation: keep it available wherever the authenticated backend has project path access, because the backend already owns the filesystem permission boundary.
