"""Regenerate the portable prototype from its single shared content page."""

import json
from pathlib import Path


root = Path(__file__).resolve().parent
data = json.dumps(json.loads((root / "mock-state.json").read_text()), ensure_ascii=False)
script = (root / "app.js").read_text()
content = (root / "content.html").read_text()
marker = '<script src="app.js"></script>'
assert content.count(marker) == 1
content = content.replace(
    marker,
    "<script>window.__SUIJI_PROTOTYPE_QUERY__=window.parent.location.search;"
    + "window.__SUIJI_PROTOTYPE_DATA__="
    + data.replace("</", "<\\/")
    + ";</script><script>"
    + script.replace("</script", "<\\/script")
    + "</script>",
)
host = (root / "index.html").read_text()
marker = 'frame.src = "content.html" + window.location.search;'
assert host.count(marker) == 1
embedded = json.dumps(content, ensure_ascii=True).replace("<", "\\u003c")
(root / "preview.html").write_text(host.replace(marker, "frame.srcdoc = " + embedded + ";"))
