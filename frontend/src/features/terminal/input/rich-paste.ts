import DOMPurify from "dompurify";
import TurndownService from "turndown";
import { tables } from "turndown-plugin-gfm";
import { fileToBase64 } from "@runweave/common/terminal";

export interface RichPasteSnapshot {
  html: string;
  plainText: string;
  files: File[];
}
export interface RichPasteDocument {
  images: {
    source: string | File;
    label: string;
    path?: string;
    error?: string;
  }[];
  markdown: (textOnly?: boolean) => string;
}

export function snapshotRichPaste(
  clipboard: DataTransfer,
): RichPasteSnapshot | null {
  const html = clipboard.getData("text/html");
  const files = Array.from(clipboard.files);
  if (!html && !files.some((file) => file.type.startsWith("image/")))
    return null;
  // Finder file-copy remains path insertion, including image files.
  if (
    !html &&
    files.length &&
    window.electronAPI?.getPathForFile &&
    files.every((file) => window.electronAPI!.getPathForFile!(file))
  )
    return null;
  return { html, files, plainText: clipboard.getData("text/plain") };
}

export function parseRichPaste(snapshot: RichPasteSnapshot): RichPasteDocument {
  if (snapshot.html.length > 2 * 1024 * 1024)
    throw new Error("富文本超过 2 MiB，原文已保留");
  const fragment = DOMPurify.sanitize(snapshot.html, {
    RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: [
      "style",
      "script",
      "iframe",
      "object",
      "embed",
      "svg",
      "math",
    ],
    // Resource resolution below, never the live DOM, decides which image schemes are usable.
    ALLOWED_URI_REGEXP:
      /^(?:(?:https?|data|cid|blob):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
  });
  const root = document.createElement("div");
  root.append(fragment);
  const images: RichPasteDocument["images"] = [];
  for (const node of root.querySelectorAll("img")) {
    const src = node.getAttribute("src") ?? "";
    let source: string | File = src;
    if (src.startsWith("cid:")) {
      const name = src.slice(4);
      const matches = snapshot.files.filter((file) => file.name === name);
      if (matches.length === 1) source = matches[0]!;
    }
    node.setAttribute("data-rich-image", String(images.length));
    node.removeAttribute("src");
    node.removeAttribute("srcset");
    images.push({
      source,
      label: node.getAttribute("alt") || `图片 ${images.length + 1}`,
    });
  }
  if (!snapshot.html) {
    root.textContent = snapshot.plainText;
    for (const file of snapshot.files.filter((entry) =>
      entry.type.startsWith("image/"),
    )) {
      const node = document.createElement("img");
      node.setAttribute("data-rich-image", String(images.length));
      root.append(node);
      images.push({ source: file, label: `图片 ${images.length + 1}` });
    }
  }
  if (images.length > 20) throw new Error("每次最多粘贴 20 张图片，原文已保留");
  const markdown = (textOnly = false) => {
    if (textOnly && snapshot.plainText) return snapshot.plainText;
    const converter = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
    });
    converter.use(tables);
    converter.addRule("complexTable", {
      filter: (node) =>
        node.nodeName === "TABLE" &&
        Boolean(node.querySelector("[colspan], [rowspan]")),
      replacement: (_content, node) =>
        "\n\n" +
        Array.from(node.querySelectorAll("tr"))
          .map((row) =>
            Array.from(row.querySelectorAll("th,td"))
              .map((cell) => converter.turndown(cell.innerHTML))
              .join(" | "),
          )
          .join("\n") +
        "\n\n",
    });
    converter.addRule("clipboardImage", {
      filter: "img",
      replacement: (_content, node) => {
        const index = Number(node.getAttribute("data-rich-image"));
        const image = images[index];
        if (textOnly) return "";
        if (!image?.path) return `[图片 ${index + 1} 未准备好]`;
        const label = image.label.replace(/[\\[\]\r\n]/g, " ");
        return `![${label}](<${image.path.replace(/</g, "%3C").replace(/>/g, "%3E")}>)`;
      },
    });
    if (!snapshot.html) {
      return [
        snapshot.plainText,
        ...Array.from(root.querySelectorAll("img")).map((node) =>
          converter.turndown(node.outerHTML),
        ),
      ]
        .filter(Boolean)
        .join("\n\n");
    }
    return converter.turndown(root);
  };
  return { images, markdown };
}

export async function prepareRichImages(
  doc: RichPasteDocument,
  cache: Map<string, { path: string; bytes: number }>,
  upload: (mimeType: string, base64: string) => Promise<string>,
  current: () => boolean,
): Promise<void> {
  let cursor = 0;
  let total = [...cache.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  const bySource = new Map<string | File, Promise<void>>();
  const byHash = new Map<string, Promise<string>>();
  const prepare = async (image: RichPasteDocument["images"][number]) => {
    if (image.path) return;
    if (!current()) throw new Error("粘贴已取消");
    let blob: Blob;
    if (image.source instanceof File) blob = image.source;
    else if (/^data:image\/(png|jpeg|gif|webp);base64,/i.test(image.source)) {
      if (image.source.length > 28 * 1024 * 1024)
        throw new Error("图片超过 20 MiB");
      blob = await (await fetch(image.source)).blob();
    } else if (/^https?:\/\//i.test(image.source)) {
      if (!window.electronAPI?.downloadClipboardImage)
        throw new Error("当前客户端不支持网络图片，请更新桌面端");
      const result = await window.electronAPI.downloadClipboardImage(
        image.source,
      );
      blob = await (
        await fetch(`data:${result.mimeType};base64,${result.dataBase64}`)
      ).blob();
    } else throw new Error("无法取得图片内容，请复制图片本身后重试");
    if (blob.size > 20 * 1024 * 1024) throw new Error("图片超过 20 MiB");
    if (
      !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
        blob.type,
      )
    )
      throw new Error("不支持的图片格式");
    const bytes = await blob.arrayBuffer();
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    )
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("");
    const previous = cache.get(hash);
    if (previous) {
      image.path = previous.path;
      return;
    }
    let pending = byHash.get(hash);
    if (!pending) {
      total += blob.size;
      if (total > 100 * 1024 * 1024)
        throw new Error("图文图片总计超过 100 MiB");
      pending = (async () => {
        if (!current()) throw new Error("粘贴已取消");
        const path = await upload(
          blob.type,
          await fileToBase64(
            new File([blob], "clipboard", { type: blob.type }),
          ),
        );
        cache.set(hash, { path, bytes: blob.size });
        return path;
      })();
      byHash.set(hash, pending);
    }
    image.path = await pending;
  };
  await Promise.all(
    Array.from({ length: Math.min(3, doc.images.length) }, async () => {
      while (cursor < doc.images.length) {
        const image = doc.images[cursor++]!;
        image.error = undefined;
        try {
          const existing = bySource.get(image.source);
          if (existing) {
            await existing;
            image.path = doc.images.find(
              (entry) => entry.source === image.source && entry.path,
            )?.path;
          } else {
            const pending = prepare(image);
            bySource.set(image.source, pending);
            await pending;
          }
        } catch (error) {
          image.error = error instanceof Error ? error.message : "图片准备失败";
        }
      }
    }),
  );
  if (doc.images.some((image) => !image.path))
    throw new Error("部分图片未准备好，内容已保留");
}
