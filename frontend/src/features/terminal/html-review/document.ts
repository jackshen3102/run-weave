import { buildAnnotationRuntimeScript, TERMINAL_BROWSER_ANNOTATION_RUNTIME_GLOBAL } from "@runweave/browser-annotation/runtime";
import { installReviewFrame, installReviewGuest } from "./guest-runtime";

const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

export function parseReviewDocument(content: string): { document?: Document; reason?: string } {
  if (new TextEncoder().encode(content).byteLength > 1024 * 1024) return { reason: "方案超过 1 MiB，不能评审" };
  const doc = new DOMParser().parseFromString(content, "text/html");
  if (!doc.querySelector('meta[name="runweave-visual-plan"][content="1"]')) return { reason: "仅支持带可视化方案标记的自包含 HTML" };
  if (doc.querySelector("base, iframe, frame, frameset, object, embed, portal, template[shadowrootmode], script[type=module]")) return { reason: "方案包含不支持的嵌套文档、base 或模块脚本" };
  if (Array.from(doc.querySelectorAll("meta[http-equiv]")).some((meta) => meta.getAttribute("http-equiv")?.toLowerCase() === "refresh")) return { reason: "方案包含自动导航" };
  const local = (url: string) => !url.trim() || /^(#|data:)/i.test(url.trim());
  for (const element of doc.querySelectorAll("*")) {
    if (element.localName === "link" && element.getAttribute("href")?.trim() &&
      /stylesheet|preload|prefetch|preconnect|import/i.test(element.getAttribute("rel") ?? "")) {
      return { reason: "评审仅支持内联样式和脚本，请使用普通 Preview 阅读资源依赖" };
    }
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase();
      if (["src", "poster", "background", "xlink:href"].includes(name) || (name === "href" && element.localName !== "a")) {
        if (!local(attr.value) || (element.localName === "script" && name === "src")) return { reason: "方案依赖外部资源，请使用普通 Preview 阅读" };
      }
      if (["srcset", "imagesrcset", "srcdoc"].includes(name) && attr.value.trim()) return { reason: "方案包含不支持的资源引用" };
    }
  }
  const css = [...Array.from(doc.querySelectorAll("style"), (node) => node.textContent ?? ""),
    ...Array.from(doc.querySelectorAll("[style]"), (node) => node.getAttribute("style") ?? "")].join("\n");
  // Escaped CSS URLs cannot be reliably classified here; keep that case in normal preview.
  if (/\\|@import|image-set\s*\(/i.test(css) || Array.from(css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)).some((match) => !local(match[2] ?? ""))) {
    return { reason: "方案样式依赖外部或不支持的资源" };
  }
  return { document: doc };
}

export function createReviewDocument(content: string, generation: string): string {
  const parsed = parseReviewDocument(content);
  if (!parsed.document) throw new Error(parsed.reason);
  const doc = parsed.document;
  const policy = doc.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = CSP;
  const bootstrap = doc.createElement("script");
  const changeEvent = "runweave-review-state";
  const runtime = buildAnnotationRuntimeScript({ changeEvent, commentLimit: 2000, maxAnnotations: 20, requestSubmit: true });
  bootstrap.textContent = `document.addEventListener("DOMContentLoaded", () => {${runtime};(${installReviewGuest.toString()})(${JSON.stringify(generation)},${JSON.stringify(TERMINAL_BROWSER_ANNOTATION_RUNTIME_GLOBAL)},${JSON.stringify(changeEvent)});}, {once:true});`;
  // No original node or script precedes these nodes in the serialized document.
  doc.head.prepend(policy, bootstrap);
  const guestContent = `<!doctype html>\n${doc.documentElement.outerHTML}`;
  const outer = document.implementation.createHTMLDocument("HTML review");
  const outerPolicy = outer.createElement("meta");
  outerPolicy.httpEquiv = "Content-Security-Policy";
  outerPolicy.content = CSP.replace("frame-src 'none'", "frame-src about:");
  outer.head.prepend(outerPolicy);
  outer.documentElement.style.cssText = "height:100%;margin:0";
  outer.body.style.cssText = "height:100%;margin:0;overflow:hidden";
  const frame = outer.createElement("iframe");
  frame.title = "Review document";
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.style.cssText = "width:100%;height:100%;border:0;display:block;background:white";
  // Serialize user HTML as an escaped attribute, never as script source.
  frame.srcdoc = guestContent;
  const relay = outer.createElement("script");
  relay.textContent = `(${installReviewFrame.toString()})(${JSON.stringify(generation)});`;
  outer.body.append(frame, relay);
  return `<!doctype html>\n${outer.documentElement.outerHTML}`;
}
