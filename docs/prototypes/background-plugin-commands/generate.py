"""Draw the one-click command and on-demand run views."""

from pathlib import Path
from xml.sax.saxutils import escape


HERE = Path(__file__).parent
SLATE_950 = "#020617"
SLATE_900 = "#0f172a"
SLATE_700 = "#334155"
SLATE_500 = "#64748b"
SLATE_400 = "#94a3b8"
SLATE_100 = "#f1f5f9"
CYAN = "#64b8ca"


def rect(x, y, w, h, fill, stroke=None, radius=0, stroke_width=1):
    border = f' stroke="{stroke}" stroke-width="{stroke_width}"' if stroke else ""
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{radius}" fill="{fill}"{border}/>'


def text(x, y, content, size, color=SLATE_100, weight=400, family="system"):
    font = 'font-family="ui-monospace,SFMono-Regular,Menlo,monospace"' if family == "mono" else ""
    return f'<text x="{x}" y="{y}" fill="{color}" font-size="{size}" font-weight="{weight}" {font}>{escape(content)}</text>'


def icon(name, x, y, size=29, color=SLATE_400):
    shapes = {
        "search": '<circle cx="10.5" cy="10.5" r="7.5"/><path d="m16.2 16.2 5.2 5.2"/>',
        "pin-off": '<path d="m2 2 20 20M9 4h7l-1 5 3 3v2H9M6 14h6v7"/>',
        "enter": '<path d="M20 4v10a4 4 0 0 1-4 4H5m5-5-5 5 5 5"/>',
        "clipboard": '<rect x="5" y="4" width="15" height="18" rx="2"/><rect x="9" y="2" width="7" height="4" rx="1"/>',
        "send": '<path d="m21 3-8 18-3-8-8-3 19-7ZM10 13l11-10"/>',
        "trash": '<path d="M4 6h16m-12 0V4h8v2M6 6l1 15h10l1-15M10 10v7m4-7v7"/>',
        "play": '<circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4V8Z"/>',
        "spinner": '<path d="M20 12a8 8 0 1 1-8-8"/>',
        "plus": '<path d="M12 4v16M4 12h16"/>',
        "check": '<path d="m5 12 5 5L19 7"/>',
        "back": '<path d="m15 18-6-6 6-6"/>',
    }
    return (
        f'<g transform="translate({x} {y}) scale({size / 24})" fill="none" '
        f'stroke="{color}" stroke-width="1.65" stroke-linecap="round" '
        f'stroke-linejoin="round">{shapes[name]}</g>'
    )


def action(name, x, y, highlighted=False, running=False):
    parts = []
    if highlighted:
        parts.append(rect(x - 4, y - 4, 43, 42, "#103542", "#367d8e", 8, 1.5))
    parts.append(icon("spinner" if running else name, x, y, 31, CYAN if highlighted else SLATE_400))
    return "".join(parts)


def draw(running):
    p = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="834" height="568" viewBox="0 0 834 568" '
        'role="img" aria-labelledby="title desc">',
        '<title id="title">快捷指令 · ' + ("后台运行中" if running else "一键后台运行") + '</title>',
        '<desc id="desc">在 Runweave 现有快捷指令卡片空余的按钮位增加后台运行操作。</desc>',
        '<style>text{font-family:ui-sans-serif,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}</style>',
        rect(0, 0, 834, 568, SLATE_950),
        rect(1, 14, 831, 550, SLATE_950, "#243348", 17, 2),
        text(18, 67, "快捷指令", 27, SLATE_100, 650),
    ]
    if running:
        p += [icon("check", 643, 44, 21, "#86efac"), text(672, 62, "已在后台运行", 17, "#a7f3d0", 500)]
    p += [
        rect(11, 97, 802, 75, SLATE_950, CYAN, 17, 4),
        rect(18, 104, 788, 60, SLATE_900, "#2a3a4e", 11),
        icon("search", 36, 121, 27, SLATE_500),
        text(76, 145, "搜索最近输入或模板", 27, SLATE_500),
        rect(18, 192, 788, 67, SLATE_900, "#263449", 11, 2),
        rect(23, 198, 260, 55, SLATE_700, None, 7),
        text(129, 235, "固定", 25, SLATE_100, 650),
        text(388, 235, "最近", 24, SLATE_400, 500),
        text(646, 235, "全部", 24, SLATE_400, 500),
        rect(18, 284, 780, 149, "#0c1527", "#27364a", 11, 2),
        text(36, 327, "创建 github pr", 25, SLATE_100, 650),
        rect(213, 302, 61, 36, SLATE_950, "#34465f", 7, 2),
        text(226, 328, "line", 21, SLATE_400, 500),
        text(36, 369, "$toolkit:github-pr main 本地所有代码", 22, SLATE_400, 500, "mono"),
        text(36, 408, "browser-viewer / wt-1 · 运行中 · 查看运行 →" if running else "browser-viewer / wt-1 · 14d ago", 18, CYAN if running else SLATE_500, 500),
        '<a href="progress.svg"><rect x="32" y="387" width="560" height="34" fill="transparent"/></a>' if running else '',
        action("pin-off", 631, 308),
        action("enter", 688, 308),
        action("clipboard", 744, 308),
        action("send", 631, 367),
        action("trash", 688, 367),
        action("play", 744, 367, highlighted=True, running=running),
    ]
    if not running:
        p += [
            rect(653, 421, 140, 36, SLATE_700, "#42536a", 7),
            text(671, 446, "后台运行", 18, SLATE_100, 550),
        ]
        p += ['<a href="running.svg">', rect(738, 361, 50, 50, "transparent"), '</a>']
    p += [
        '<path d="M18 458H806" stroke="#27364a" stroke-width="2"/>',
        icon("plus", 35, 497, 27, SLATE_100),
        text(74, 522, "保存快捷指令", 25, SLATE_100, 500),
        '</svg>',
    ]
    (HERE / ("running.svg" if running else "index.svg")).write_text("\n".join(p) + "\n", encoding="utf-8")


def draw_detail(completed):
    title = "运行结果" if completed else "执行过程"
    p = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="834" height="568" viewBox="0 0 834 568" '
        'role="img" aria-labelledby="title desc">',
        f'<title id="title">快捷指令 · {title}</title>',
        '<desc id="desc">点击快捷指令卡片上的查看运行，按需查看过程或最终结果的静态原型。</desc>',
        '<style>text{font-family:ui-sans-serif,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif} a{cursor:pointer}</style>',
        rect(0, 0, 834, 568, SLATE_950),
        rect(1, 14, 831, 550, SLATE_950, "#243348", 17, 2),
        icon("back", 24, 44, 30, SLATE_400),
        '<a href="running.svg"><rect x="18" y="35" width="42" height="45" fill="transparent"/></a>',
        text(74, 67, "创建 github pr", 27, SLATE_100, 650),
        text(74, 90, "browser-viewer / wt-1", 17, SLATE_400),
        rect(18, 99, 798, 86, SLATE_900, "#27364a", 10, 2),
        icon("check" if completed else "spinner", 38, 123, 27, "#86efac" if completed else CYAN),
        text(77, 146, "已完成" if completed else "后台运行中", 23, "#a7f3d0" if completed else SLATE_100, 600),
        text(77, 173, "完成通知可直接打开本次记录" if completed else "可离开此页；点击通知或卡片可随时回来看", 17, SLATE_400),
    ]
    if completed:
        p += [
            text(18, 229, "运行结果", 21, SLATE_100, 600),
            rect(18, 246, 798, 143, "#0c1527", "#27364a", 10, 2),
            text(36, 282, "示例结果", 17, SLATE_500, 500),
            text(36, 316, "已创建 PR #123，检查通过", 23, SLATE_100, 550),
            text(36, 355, "PR 链接、错误原因或待处理事项显示在这里", 17, SLATE_400),
            text(18, 432, "查看完整执行过程 →", 19, CYAN, 500),
            '<a href="progress.svg"><rect x="14" y="405" width="260" height="42" fill="transparent"/></a>',
            '<path d="M18 458H806" stroke="#27364a" stroke-width="2"/>',
            rect(18, 480, 798, 62, SLATE_900, "#3d6673", 10, 2),
            text(36, 518, "打开原对话并继续追问 →", 21, CYAN, 550),
        ]
    else:
        p += [
            text(18, 227, "执行过程", 21, SLATE_100, 600),
            text(718, 227, "实时更新", 17, SLATE_500),
            rect(18, 246, 798, 208, "#0c1527", "#27364a", 10, 2),
            text(36, 282, "示例输出", 17, SLATE_500, 500),
            text(36, 315, "› 检查当前项目与工作区", 19, SLATE_400, 400, "mono"),
            text(36, 349, "› 执行已保存的技能指令", 19, SLATE_400, 400, "mono"),
            text(36, 383, "› 等待远端检查结果…", 19, SLATE_400, 400, "mono"),
            text(36, 428, "输出可滚动查看", 16, SLATE_500),
            text(18, 506, "模拟运行结束后查看结果 →", 18, CYAN, 500),
            '<a href="result.svg"><rect x="14" y="480" width="320" height="42" fill="transparent"/></a>',
        ]
    p += ['</svg>']
    (HERE / ("result.svg" if completed else "progress.svg")).write_text("\n".join(p) + "\n", encoding="utf-8")


draw(False)
draw(True)
draw_detail(False)
draw_detail(True)
