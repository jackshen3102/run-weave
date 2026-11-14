// DOM evidence helpers serialized into both Browser and isolated HTML documents.
export const ANNOTATION_TARGET_RUNTIME = `    const cssEscape = (value) => {
      if (window.CSS?.escape) {
        return window.CSS.escape(value);
      }
      return String(value).replace(/[^a-zA-Z0-9_-]/g, (char) => "\\\\" + char);
    };
    const trimText = (value, max = 120) => {
      const text = String(value ?? "").replace(/\\s+/g, " ").trim();
      return text.length > max ? text.slice(0, max - 1) + "..." : text;
    };
    const normalizeComment = (value, max = 4000) => {
      const text = String(value ?? "").replace(/\\r\\n?/g, "\\n").trim();
      return options.commentLimit ? String(value ?? "") : text.length > max ? text.slice(0, max) : text;
    };
    const elementLabel = (element) => {
      const aria = element.getAttribute("aria-label");
      const title = element.getAttribute("title");
      const text = trimText(element.innerText || element.textContent || "");
      return trimText(aria || title || text || element.tagName.toLowerCase());
    };
    const elementPath = (element) => {
      const parts = [];
      let current = element;
      while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 6) {
        parts.unshift(current.tagName.toLowerCase());
        if (current === document.body) {
          break;
        }
        current = current.parentElement;
      }
      return parts.join(" > ");
    };
    const nthOfType = (element) => {
      let index = 1;
      let sibling = element.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === element.tagName) {
          index += 1;
        }
        sibling = sibling.previousElementSibling;
      }
      return index;
    };
    const elementSelector = (element) => {
      const testId = element.getAttribute("data-testid");
      if (testId) {
        return '[data-testid="' + cssEscape(testId) + '"]';
      }
      if (element.id) {
        return "#" + cssEscape(element.id);
      }
      const aria = element.getAttribute("aria-label");
      if (aria) {
        return element.tagName.toLowerCase() + '[aria-label="' + cssEscape(aria) + '"]';
      }
      const parts = [];
      let current = element;
      while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
        const tag = current.tagName.toLowerCase();
        parts.unshift(tag + ":nth-of-type(" + nthOfType(current) + ")");
        if (current.id) {
          parts[0] = tag + "#" + cssEscape(current.id);
          break;
        }
        current = current.parentElement;
      }
      return parts.join(" > ") || element.tagName.toLowerCase();
    };
    const targetForElement = (element) => {
      const rect = element.getBoundingClientRect();
      const viewport = {
        width: Math.round(window.innerWidth),
        height: Math.round(window.innerHeight),
      };
      return {
        ...(options.changeEvent ? { elementId: element.id } : {}),
        pageUrl: window.location.href,
        frameLabel: window.self === window.top ? "top document" : window.location.href,
        targetText: elementLabel(element),
        targetSelector: elementSelector(element),
        targetPath: elementPath(element),
        nodePosition: {
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        },
        viewport,
        rect: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        devicePixelRatio: window.devicePixelRatio || 1,
      };
    };

`;
