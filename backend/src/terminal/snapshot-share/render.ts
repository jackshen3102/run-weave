import { createHash } from "node:crypto";
import type { TerminalSnapshotRecord } from "./store";

const style = `body{margin:16px 12px;background:#fff;color:#171717;font:13px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace}
.code-line{display:flex;min-height:1.7em;scroll-margin-top:16px}
.line-number{flex:0 0 4.5em;box-sizing:border-box;padding-right:1em;color:#999;text-align:right;text-decoration:none;user-select:none}
.line-number:hover{color:#171717}
.line-text{flex:1;min-width:0;font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}
.code-line.selected{background:#fff2b3}.code-line.selected .line-number{color:#765800}
@media(max-width:600px){body{margin:8px 4px}}`;

// Only fixed code enters this script. Snapshot text is never interpolated here.
const script = `(() => {
const rows = document.querySelectorAll('.code-line');
let anchor = null;
function highlight(start, end) {
  rows.forEach((row, index) => row.classList.toggle('selected', index + 1 >= start && index + 1 <= end));
}
function readHash() {
  const match = /^#L(\\d+)(?:-L?(\\d+))?$/.exec(location.hash);
  const start = Number(match?.[1]);
  const end = Number(match?.[2] || match?.[1]);
  if (!match || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > rows.length) {
    anchor = null;
    highlight(0, 0);
    return;
  }
  anchor = start;
  highlight(start, end);
  rows[start - 1].scrollIntoView({block: 'center'});
}
document.addEventListener('click', (event) => {
  const link = event.target.closest?.('.line-number');
  if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey) return;
  event.preventDefault();
  const line = Number(link.getAttribute('href').slice(2));
  if (!event.shiftKey || anchor === null) anchor = line;
  const start = Math.min(anchor, line);
  const end = Math.max(anchor, line);
  highlight(start, end);
  history.replaceState(null, '', '#L' + start + (start === end ? '' : '-L' + end));
});
window.addEventListener('hashchange', readHash);
readHash();
})();`;

function hash(value: string): string {
  return `'sha256-${createHash("sha256").update(value).digest("base64")}'`;
}

export const terminalSnapshotShareHeaders = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Content-Security-Policy": `default-src 'none'; style-src ${hash(style)}; script-src ${hash(script)}; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

/** Stream bounded chunks: 10 MiB of blank lines must not build a giant HTML string. */
export function* renderTerminalSnapshot(record: TerminalSnapshotRecord): Generator<string> {
  yield `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(record.title)}</title><style>${style}</style></head><body><main aria-label="快照正文">`;
  let start = 0;
  let line = 1;
  let chunk = "";
  while (start <= record.text.length) {
    const newline = record.text.indexOf("\n", start);
    const end = newline === -1 ? record.text.length : newline;
    chunk += `<div class="code-line" id="L${line}"><a class="line-number" href="#L${line}" aria-label="第 ${line} 行">${line}</a><code class="line-text">${escapeHtml(record.text.slice(start, end))}</code></div>\n`;
    if (chunk.length >= 64 * 1024) {
      yield chunk;
      chunk = "";
    }
    if (newline === -1) break;
    start = newline + 1;
    line += 1;
  }
  if (chunk) yield chunk;
  yield `</main><script>${script}</script></body></html>`;
}

export function renderTerminalSnapshotMissing(): string {
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>快照不存在或已过期</title></head><body>快照不存在或已过期</body></html>';
}
