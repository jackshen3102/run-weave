// Reading needs no JavaScript; this only adds stable line-range selection.
const rows = [...document.querySelectorAll('.code-line')];
let anchor = null;

function highlight(start, end) {
  rows.forEach((row, index) => {
    row.classList.toggle('selected', index + 1 >= start && index + 1 <= end);
  });
}

function readHash() {
  const match = /^#L(\d+)(?:-L?(\d+))?$/.exec(location.hash);
  const start = Number(match?.[1]);
  const end = Number(match?.[2] || match?.[1]);
  if (!match || start < 1 || end < start || end > rows.length) {
    anchor = null;
    highlight(0, 0);
    return;
  }
  anchor = start;
  highlight(start, end);
  rows[start - 1].scrollIntoView({ block: 'center' });
}

rows.forEach((row, index) => {
  row.querySelector('.line-number').addEventListener('click', (event) => {
    // Keep the browser's open-in-new-tab behavior for command/control clicks.
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    if (!event.shiftKey || anchor === null) anchor = index + 1;
    const start = Math.min(anchor, index + 1);
    const end = Math.max(anchor, index + 1);
    highlight(start, end);
    history.replaceState(null, '', `#L${start}${start === end ? '' : `-L${end}`}`);
  });
});

window.addEventListener('hashchange', readHash);
readHash();
