import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../../../ui/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "../../../ui/alert-dialog";
import { Input } from "../../../ui/input";
import { Label } from "../../../ui/label";
import { Button } from "../../../ui/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "../../../ui/select";
import type { BookmarkControls } from "./use-bookmarks";
export function BookmarkEditors({
  bookmarks: b,
}: {
  bookmarks: BookmarkControls;
}) {
  const [folderSelectOpen, setFolderSelectOpen] = useState(false);
  const e = b.editor;
  const f = b.folderEditor;
  return (
    <>
      <Dialog
        open={Boolean(e && !f)}
        onOpenChange={(open) => {
          if (!open && !folderSelectOpen) b.setEditor(null);
        }}
      >
        <DialogContent
          className="max-w-sm"
          onEscapeKeyDown={(event) => {
            if (folderSelectOpen) {
              event.preventDefault();
              setFolderSelectOpen(false);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{e?.fresh ? "已添加收藏" : "编辑收藏"}</DialogTitle>
            <DialogDescription className="sr-only">
              修改收藏名称、网址和文件夹
            </DialogDescription>
          </DialogHeader>
          {e ? (
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void b.saveEditor();
              }}
            >
              <div className="flex flex-col gap-2">
                <Label htmlFor="bookmark-title">名称</Label>
                <Input
                  id="bookmark-title"
                  value={e.title}
                  onChange={(event) =>
                    b.setEditor({ ...e, title: event.target.value })
                  }
                  required
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="bookmark-url">网址</Label>
                <Input
                  id="bookmark-url"
                  value={e.url}
                  onChange={(event) =>
                    b.setEditor({ ...e, url: event.target.value })
                  }
                  required
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="bookmark-folder">文件夹</Label>
                <Select
                  open={folderSelectOpen}
                  onOpenChange={setFolderSelectOpen}
                  value={e.parentId ?? "root"}
                  onValueChange={(value) =>
                    b.setEditor({
                      ...e,
                      parentId: value === "root" ? null : value,
                    })
                  }
                >
                  <SelectTrigger id="bookmark-folder">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent
                    onEscapeKeyDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setFolderSelectOpen(false);
                    }}
                  >
                    <SelectGroup>
                      <SelectItem value="root">收藏栏</SelectItem>
                      {b.snapshot?.entries
                        .filter((x) => x.kind === "folder")
                        .map((x) => (
                          <SelectItem key={x.id} value={x.id}>
                            {x.title}
                          </SelectItem>
                        ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
              <Button
                variant="ghost"
                type="button"
                className="self-start"
                disabled={b.pending}
                onClick={() =>
                  b.setFolderEditor({ title: "", returnToEditor: true })
                }
              >
                ＋ 新建文件夹
              </Button>
              {b.error ? (
                <p role="alert" className="text-sm text-destructive">
                  {b.error}
                </p>
              ) : null}
              <DialogFooter>
                <Button
                  variant="ghost"
                  type="button"
                  disabled={b.pending}
                  onClick={() => {
                    const entry = b.snapshot?.entries.find(
                      (x) => x.id === e.id,
                    );
                    if (entry) void b.remove(entry);
                  }}
                >
                  移除收藏
                </Button>
                <Button type="submit" disabled={b.pending}>
                  完成
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(f)}
        onOpenChange={(open) => {
          if (!open) b.setFolderEditor(null);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{f?.id ? "重命名文件夹" : "新建文件夹"}</DialogTitle>
            <DialogDescription className="sr-only">
              为文件夹设置名称
            </DialogDescription>
          </DialogHeader>
          {f ? (
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void b.saveFolder();
              }}
            >
              <Label htmlFor="bookmark-folder-title">名称</Label>
              <Input
                id="bookmark-folder-title"
                value={f.title}
                onChange={(event) =>
                  b.setFolderEditor({ ...f, title: event.target.value })
                }
                autoFocus
                required
              />
              {b.error ? (
                <p role="alert" className="text-sm text-destructive">
                  {b.error}
                </p>
              ) : null}
              <DialogFooter>
                <Button
                  variant="outline"
                  type="button"
                  onClick={() => b.setFolderEditor(null)}
                >
                  取消
                </Button>
                <Button type="submit" disabled={b.pending}>
                  {f.id ? "保存" : "创建"}
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={Boolean(b.deleting)}
        onOpenChange={(open) => {
          if (!open) b.setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除「{b.deleting?.title}」？</AlertDialogTitle>
            <AlertDialogDescription>
              其中的{" "}
              {b.deleting?.kind === "folder" ? b.deleting.children.length : 0}{" "}
              项收藏也会被删除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {b.error ? <p role="alert">{b.error}</p> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={b.pending}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={b.pending}
              onClick={(event) => {
                event.preventDefault();
                if (b.deleting) void b.remove(b.deleting, true);
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
