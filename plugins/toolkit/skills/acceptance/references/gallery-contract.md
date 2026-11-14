# 图文材料与验收报告数据合同

## 输入与兼容

UTF-8 JSON，拒绝重复键、未知字段、NaN 和未知版本。文件路径相对 `--input-root`；`--input` 默认 `task.json`。根目录必须已存在。ID 为 1–80 位字母、数字、`-`、`_`，首位为字母或数字。

新报告使用 `schemaVersion: 2`。旧版 `schemaVersion: 1` 输入继续支持，不修改历史产物，也不根据旧页的 observed 自动推导通过结论。v1 不接受 report 或 item.summary；升级时必须按实际记录补齐报告，不能仅改版本号。

| 对象   | 字段                                                                                                                               |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| root   | `schemaVersion: 1/2`、`task`、`assets: []`、`pages: []`；v2 必须有 `report`                                                        |
| task   | `id`、`title`、`scope`、`materialKind: current/historical`、`limitations: string[]`                                                |
| asset  | 唯一 `id`、`kind: image/text`、`path`、`label`、`origin`                                                                           |
| origin | `surface`、`capturedAt`、`sourceRef`，每项为非空字符串或 `null`                                                                    |
| page   | 唯一 `id`、`type`、`title`、`description`、`evidenceState`、`items`、`sourceIds: string[]`；可选 `lookAt`、`limitations: string[]` |
| item   | `assetId`、`label`；图片项必需 `alt`，可选 `crop: {x,y,width,height}`；v2 文字项可选 `summary`，不接受 alt/crop                    |
| report | `summary`、非空数组 `checks`                                                                                                       |
| check  | 唯一 `id`、`title`、`expected`、`actual`、`execution`、`outcome`、`pageIds: string[]`                                              |

文字必填项须为非空字符串。时间按实际采集记录填写，建议带时区 ISO 8601；不知道则 `null`。版本、设备、对象身份等条件写在 scope、description 或关联文字记录中，`sourceRef` 给其原始位置或记录标识。各素材允许不同来源，但不能因此宣称同一事件。

## 验收项与首屏总览（v2）

- `report.summary`：作者写的一段总体判断及关键保留条件；只总结本次真实记录，不由生成器计算“整体通过”。task.limitations 直接可见，不折叠关键边界。
- 每项 check 对应一个可判断的用户目标。`expected` 写标准，`actual` 写操作后观察或未执行/阻塞原因。不要把“桌面 UI 检查”和“真机扫码成功”合为一项再统一标通过。
- `execution` 为 `real`（实际执行）、`mock`（确实在 Mock/模拟环境执行）、`not-run`（没有执行）。没有证据不能凭空改称 Mock；运行端及浏览器模拟/真机的具体边界仍需写明。
- `outcome` 为 `pass`、`fail`、`blocked`、`not-run`，是报告作者记录的**自检结果**，不代表用户验收确认。实际执行后观察到不符合标准可记 fail；无法得出结果时记 blocked 并说明原因。
- `pageIds` 只引用本报告已有证据页且不重复，可为空。pass/fail 必须关联至少一页 observed；pass 不可引用 insufficient/not-run 的页作为支持。not-run 结果只能配 not-run 执行；未执行不能标 pass/fail。
- 失败、阻塞、未执行项在总览中优先且默认展开；通过项显示标题及执行方式，按需展开预期、实际和证据链接。是否有图不影响缺口的可见性。
- v2 允许 `pages: []`、`assets: []`，用于只有阻塞或未执行项的报告，不要求制造截图或无意义文字文件。v1 仍至少需要一页。

校验只检查结构、引用和显式状态是否自洽，无法判定截图真假、目标是否遗漏或作者结论是否正确。报告必须覆盖本次约定的目标，包括没有执行的部分；不能仅列成功项。

## 证据页与素材

| type     | items 数量 | 素材 kind |
| -------- | ---------- | --------- |
| single   | 1          | image     |
| compare  | 2          | image     |
| sequence | 2–4        | image     |
| text     | 1          | text      |

页面数组顺序为证据阅读顺序。页面 ID 用于 `#page=<id>`，修改描述时保留 ID。

`evidenceState` 为 `observed`（有观察材料）、`insufficient`（证据不足）、`not-run`（未执行），不含业务通过/失败判定。后两项的具体缺口写在正文或 limitations 中。observed 同样可以记录失败，不能根据页数计算通过率。

v2 文字项的 `summary` 是面向用户的简短摘要，按正常正文排版；原始文字不被替换或截断，点击“打开原文”即可核对。不填 summary 时仍显示完整等宽原文。来源区只列出处和打开入口，不重复铺开全文。所有文本均为纯文本，不解析 Markdown/HTML。

`sourceIds` 只引用 text 素材，可为空。PNG/JPEG 图片最大 32 MiB、宽高各最多 32768px；文字 TXT/MD/JSON 及输入 JSON 最大 2 MiB。JSON 素材也要求合法 JSON。PNG 校验结构和 CRC；JPEG 检查容器与常用 SOF 尺寸，完整解码由浏览器验证。素材上限不等于 Runweave 交付上限，见下文预检。

`crop` 为原 PNG 整数像素坐标，x/y 非负、width/height 为正且完整位于原图内。JPEG 仅允许完整展示，避免 EXIF 方向与坐标歧义。原图不被重采样或写回。

## 最小可执行输入

以下示例明确表示没有执行；保存为 `task.json` 即可生成无素材的范围说明报告。使用时将目标、标准和原因改为本次事实。补充真实证据之后才能改结果，不要复制示例冒充完成验收。

```json
{
  "schemaVersion": 2,
  "task": {
    "id": "current-task",
    "title": "当前任务验收报告",
    "scope": "填写本次版本、环境与目标范围",
    "materialKind": "current",
    "limitations": ["尚未连接目标设备，不能确认真机行为。"]
  },
  "report": {
    "summary": "真机路径尚未执行，本报告不作通过结论。",
    "checks": [
      {
        "id": "phone-flow",
        "title": "手机完成目标操作",
        "expected": "在目标真机完成操作并核对保存后的状态。",
        "actual": "未连接目标设备，没有执行此路径。",
        "execution": "not-run",
        "outcome": "blocked",
        "pageIds": []
      }
    ]
  },
  "assets": [],
  "pages": []
}
```

有真实记录时按上方 asset/page 合同补充素材。文字项示例为 `{"assetId":"observation","label":"执行记录","summary":"填写该记录支持的实际观察与限制。"}`；check.pageIds 引用对应页的 id，而不是素材 id。

## 交付预检、输出与错误

- `validate` 返回 `{valid, pages, assets}`，只验证输入，不写文件；不证明可通过 Backend 交付。
- `build` 默认 `--target runweave`，生成临时成果后按 Runweave 的 HTML 1 MiB、单资源 5 MiB 上限检查完整清单。不可交付则退出 1 并指出文件，最终目录不落盘；不读取凭据或申请票据。
- 明确需要离线大文件时使用 `build --target portable`。仍保留原素材并返回 `deliveryCheck`，其中 ready:false 表示不能通过当前 Runweave 入口，不能当作已交付成功。
- `build` 返回 `{output, index, pages, target, deliveryCheck}`。`deliveryCheck` 含 `target`、`ready`、`filesChecked`、`issues`；本地通过不证明资源解码、浏览器加载或手机可达。
- 已生成报告可运行 `gallery.py preflight --directory <成果目录>`，输出本地检查 JSON，ready 为 false 时退出 1。详细入口与票据流程见 [预览与检查](delivery.md)。
- 成功退出 0；输入、文件或运行错误退出 1，命令参数错误退出 2，stderr 给出原因。`serve` 前台长驻，第一行返回 `{url,pid,directory,stop}`；Ctrl-C 正常停止。

输出文件：`index.html`、`reader.css`、`report.css`、`viewer.css`、`reader.js`、`task.json`、`manifest.json` 与 `assets/`。文字内嵌进页面，不依赖 fetch 或外网；原始文字与图片也单独保留。task.json 保持输入合同，path 改为成果内相对路径。manifest 保存 schemaVersion、templateVersion、原始输入摘要及复制素材 SHA-256。

生成失败不留下最终目录，已有输出拒绝覆盖。生成器用同目标的临时锁串行化生成；进程被强杀可能留下 `.gallery-lock` 和 `.gallery-*`，核对没有相同目标构建在运行后，才清理这些本次临时文件或换新输出目录。不要删除旧成果绕过覆盖检查。

每份报告带模板副本，后续升级不改变旧报告。生成器只处理显式列出的素材，不自动爬取来源、执行命令或读整个历史。

## 原始素材查看与本地服务

正文图片、标题旁的原图/原文和来源链接都在阅读器内部打开，不依赖弹窗或页面跳转。图片可切换实际尺寸并滚动；关闭后保持原来的页码和焦点。原图与原文文件仍单独保留，复制成果目录后可直接使用。Backend 的 HTML 预览沙箱与真机阅读仍须通过实际入口核对，不能仅凭本地打开推断。

`serve` 只绑定 `127.0.0.1`，只允许清单中的文件，不开放目录列表和写接口；根目录越界及符号链接逃逸均拒绝。素材路径不接受绝对路径、`..`、反斜线、冒号或远程 URL。页面文本转义显示，不支持任务传入 HTML。输入输出根目录应由当前用户控制，不将此本机工具部署为多用户公共服务。
