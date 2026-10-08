/* A portable renderer: task content is always text, never markup. */
/* global document, matchMedia, location, addEventListener, console */
(() => {
  "use strict";
  const byId = (id) => document.getElementById(id);
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const link = (text, href) => {
    const node = el("a", text);
    node.href = href;
    node.target = "_blank";
    node.rel = "noopener noreferrer";
    return node;
  };
  try {
    const data = JSON.parse(byId("gallery-data").textContent);
    const assets = new Map(data.assets.map((asset) => [asset.id, asset]));
    const pageNodes = [],
      headings = [],
      directoryLinks = [];
    let selected = 0,
      expanded = false;
    const types = {
      single: "单图",
      compare: "对照",
      sequence: "关键状态",
      text: "文字证据",
    };
    const limits = (values) => {
      const box = el("div", undefined, "limits");
      const list = el("ul");
      values.forEach((value) => list.append(el("li", value)));
      box.append(list);
      return box;
    };
    const origin = (asset) => {
      const { surface, capturedAt, sourceRef } = asset.origin;
      return `来源：${surface || "未记录运行端"} · 时间：${capturedAt || "未记录"} · ${sourceRef || "未记录来源位置"}`;
    };
    const media = (item) => {
      const asset = assets.get(item.assetId);
      const figure = el("figure");
      const caption = el("figcaption");
      caption.append(
        el("strong", item.label),
        link(asset.kind === "image" ? "打开原图 ↗" : "打开原文 ↗", asset.path),
      );
      figure.append(caption);
      if (asset.kind === "text") {
        figure.append(el("pre", asset.text, "text-evidence"));
        return figure;
      }
      const stage = el("div", undefined, "image-stage");
      const anchor = link("", asset.path);
      anchor.setAttribute("aria-label", `打开原图：${item.label}`);
      const img = el("img");
      img.alt = item.alt;
      img.width = asset.width;
      img.height = asset.height;
      img.addEventListener("error", () => {
        stage.replaceChildren(
          el(
            "p",
            `图片不可用：${item.label}。请核对成果目录中的原图文件。`,
            "media-error",
          ),
        );
      });
      if (item.crop) {
        const crop = item.crop;
        const viewport = el("div", undefined, "crop");
        viewport.style.width = `${crop.width}px`;
        viewport.style.aspectRatio = `${crop.width} / ${crop.height}`;
        img.style.width = `${(asset.width / crop.width) * 100}%`;
        img.style.left = `${(-crop.x / crop.width) * 100}%`;
        img.style.top = `${(-crop.y / crop.height) * 100}%`;
        viewport.append(img);
        anchor.append(viewport);
      } else anchor.append(img);
      img.src = asset.path;
      stage.append(anchor);
      figure.append(stage);
      if (item.crop)
        figure.append(el("p", "局部取景 · 完整原图保持不变", "crop-note"));
      figure.append(el("p", asset.origin.surface || "运行端未记录", "origin"));
      return figure;
    };
    byId("task-title").textContent = data.task.title;
    byId("task-scope").textContent = data.task.scope;
    byId("material-kind").textContent =
      data.task.materialKind === "historical" ? "历史示例" : "当前任务";
    if (data.task.limitations.length) {
      byId("task-limits").hidden = false;
      data.task.limitations.forEach((value) =>
        byId("task-limits").querySelector("ul").append(el("li", value)),
      );
    }
    data.pages.forEach((page, index) => {
      const section = el("article", undefined, "page");
      section.id = `page-${page.id}`;
      section.dataset.pageId = page.id;
      section.dataset.type = page.type;
      section.setAttribute("aria-labelledby", `heading-${page.id}`);
      const heading = el("h2", page.title, "page-heading");
      heading.id = `heading-${page.id}`;
      heading.tabIndex = -1;
      section.append(
        el(
          "p",
          `${String(index + 1).padStart(2, "0")} / ${types[page.type]}`,
          "eyebrow",
        ),
        heading,
      );
      if (page.evidenceState !== "observed")
        section.append(
          el(
            "p",
            page.evidenceState === "not-run" ? "此项未执行" : "此项证据不足",
            "evidence-label",
          ),
        );
      section.append(el("p", page.description, "description"));
      if (page.limitations?.length) section.append(limits(page.limitations));
      if (page.type === "sequence")
        section.append(
          el(
            "p",
            "以下为离散关键状态，不代表连续录像或实际等待时长。",
            "sequence-note",
          ),
        );
      const grid = el("div", undefined, `media-grid ${page.type}`);
      page.items.forEach((item) => grid.append(media(item)));
      section.append(grid);
      if (page.lookAt)
        section.append(el("p", `看这里：${page.lookAt}`, "look-at"));
      const details = el("details", undefined, "sources");
      details.append(el("summary", "查看来源与条件"));
      const ids = new Set([
        ...page.items.map((item) => item.assetId),
        ...page.sourceIds,
      ]);
      ids.forEach((id) => {
        const asset = assets.get(id);
        const item = el("div", undefined, "source-item");
        item.append(link(asset.label, asset.path), el("p", origin(asset)));
        if (asset.kind === "text")
          item.append(el("pre", asset.text, "text-evidence"));
        details.append(item);
      });
      section.append(details);
      byId("pages").append(section);
      pageNodes.push(section);
      headings.push(heading);
      const entry = el("a");
      entry.href = `#page=${page.id}`;
      entry.append(
        el("span", String(index + 1).padStart(2, "0")),
        el("span", page.title),
      );
      entry.addEventListener("click", (event) => {
        event.preventDefault();
        select(index, true);
        if (matchMedia("(max-width:760px)").matches)
          byId("directory-details").open = false;
      });
      byId("directory").append(entry);
      directoryLinks.push(entry);
    });
    function render(focus = false) {
      pageNodes.forEach((node, i) => {
        node.hidden = !expanded && i !== selected;
      });
      directoryLinks.forEach((node, i) => {
        if (i === selected) node.setAttribute("aria-current", "page");
        else node.removeAttribute("aria-current");
      });
      const total = data.pages.length;
      byId("page-count").textContent = `${selected + 1} / ${total}`;
      byId("page-name").textContent = data.pages[selected].title;
      byId("previous").disabled = selected === 0;
      byId("next").disabled = selected === total - 1;
      byId("navigation").hidden = total === 1 || expanded;
      byId("expand").hidden = total === 1;
      byId("expand").textContent = expanded ? "返回分页" : "展开全部";
      byId("expand").setAttribute("aria-pressed", String(expanded));
      document.body.classList.toggle("expanded", expanded);
      document.body.classList.toggle("single-task", total === 1);
      byId("announcement").textContent =
        `${expanded ? "全部展开，当前定位" : "第"} ${selected + 1} / ${total} 页：${data.pages[selected].title}`;
      if (focus) {
        headings[selected].focus({ preventScroll: true });
        pageNodes[selected].scrollIntoView({ block: "start" });
      }
    }
    function select(index, focus) {
      selected = Math.max(0, Math.min(data.pages.length - 1, index));
      const hash = `#page=${data.pages[selected].id}`;
      if (location.hash !== hash) location.hash = hash;
      byId("notice").hidden = true;
      render(focus);
    }
    function readHash(focus) {
      let id = "";
      try {
        id = decodeURIComponent(location.hash.replace(/^#page=/, ""));
      } catch {
        id = "invalid";
      }
      const index = data.pages.findIndex((page) => page.id === id);
      if (location.hash && index < 0) {
        select(0, focus);
        byId("notice").textContent = "没有找到该页，已返回第一页。";
        byId("notice").hidden = false;
      } else {
        selected = Math.max(0, index);
        render(focus);
      }
    }
    byId("previous").addEventListener("click", () =>
      select(selected - 1, true),
    );
    byId("next").addEventListener("click", () => select(selected + 1, true));
    document.querySelector(".skip-link").addEventListener("click", (event) => {
      event.preventDefault();
      render(true);
    });
    byId("expand").addEventListener("click", () => {
      expanded = !expanded;
      render(!expanded);
    });
    addEventListener("hashchange", () => readHash(true));
    addEventListener("keydown", (event) => {
      if (
        expanded ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.target.closest(
          "input,textarea,select,[contenteditable]:not([contenteditable=false]),pre",
        )
      )
        return;
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        event.preventDefault();
        select(selected + (event.key === "ArrowRight" ? 1 : -1), true);
      }
    });
    let printDetails = [];
    addEventListener("beforeprint", () => {
      printDetails = [...document.querySelectorAll("details")].map((node) => [
        node,
        node.open,
      ]);
      printDetails.forEach(([node]) => {
        node.open = true;
      });
    });
    addEventListener("afterprint", () =>
      printDetails.forEach(([node, open]) => {
        node.open = open;
      }),
    );
    if (matchMedia("(max-width:760px)").matches)
      byId("directory-details").open = false;
    readHash(false);
  } catch (error) {
    byId("pages").replaceChildren(
      el("p", "材料无法读取。请从 task.json 重新校验并生成成果。", "fatal"),
    );
    byId("navigation").hidden = true;
    byId("expand").hidden = true;
    console.error("Gallery render failed", error);
  }
})();
