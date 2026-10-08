# 图文材料数据合同 v1

## 输入

UTF-8 JSON，拒绝重复键、未知字段、NaN 和未知版本。文件路径相对 `--input-root`；`--input` 默认 `task.json`。根目录必须已存在。ID 为 1–80 位字母、数字、`-`、`_`，首位为字母或数字。

| 对象   | 字段                                                                                                                               |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| root   | `schemaVersion: 1`、`task`、`assets: []`、`pages: []`                                                                              |
| task   | `id`、`title`、`scope`、`materialKind: current/historical`、`limitations: string[]`                                                |
| asset  | 唯一 `id`、`kind: image/text`、`path`、`label`、`origin`                                                                           |
| origin | `surface`、`capturedAt`、`sourceRef`，每项为非空字符串或 `null`                                                                    |
| page   | 唯一 `id`、`type`、`title`、`description`、`evidenceState`、`items`、`sourceIds: string[]`；可选 `lookAt`、`limitations: string[]` |
| item   | `assetId`、`label`；图片项必需 `alt`，可选 `crop: {x,y,width,height}`；文字项不接受 alt/crop                                       |

文字必填项须为非空字符串。时间按实际采集记录填写，建议带时区 ISO 8601；不知道则 `null`。版本、设备、对象身份等条件写在 scope、description 或关联文字记录中，`sourceRef` 给其原始位置或记录标识。各素材允许不同来源，但不能因此宣称同一事件。

| type     | items 数量 | 素材 kind |
| -------- | ---------- | --------- |
| single   | 1          | image     |
| compare  | 2          | image     |
| sequence | 2–4        | image     |
| text     | 1          | text      |

`pages` 至少一项；数组顺序为阅读顺序。页面 ID 用于 `#page=<id>`，修改描述时保留 ID。

`evidenceState` 为 `observed`（有观察材料）、`insufficient`（证据不足）、`not-run`（未执行），不含业务通过/失败判定。后两项的具体缺口应写在正文或 limitations 中；未执行又没有截图时用真实文字说明页，不造图。

`sourceIds` 只引用 text 素材，可为空。PNG/JPEG 图片最大 32 MiB、宽高各最多 32768px；文字 TXT/MD/JSON 及输入 JSON 最大 2 MiB。JSON 素材也要求合法 JSON。PNG 校验结构和 CRC；JPEG 检查容器与常用 SOF 尺寸，完整解码由浏览器验证。若图片打不开，不能只依据 validate 成功交付。

`crop` 为原 PNG 整数像素坐标，x/y 非负、width/height 为正且完整位于原图内。JPEG 仅允许完整展示，避免 EXIF 方向与坐标歧义。原图不被重采样或写回。

## 最小可执行输入

在同一输入目录准备真实的 `observation.txt`，再保存如下 `task.json`；把示例内容改成当前任务事实后执行。

```json
{
  "schemaVersion": 1,
  "task": {
    "id": "current-task",
    "title": "当前任务的核对结果",
    "scope": "说明本次核对范围与环境",
    "materialKind": "current",
    "limitations": []
  },
  "assets": [
    {
      "id": "observation",
      "kind": "text",
      "path": "observation.txt",
      "label": "实际观察记录",
      "origin": { "surface": "CLI", "capturedAt": null, "sourceRef": null }
    }
  ],
  "pages": [
    {
      "id": "result",
      "type": "text",
      "title": "本次实际观察到了什么",
      "description": "交代操作条件、实际动作与观察，不超过原始记录的证据范围。",
      "evidenceState": "observed",
      "items": [{ "assetId": "observation", "label": "结果原文" }],
      "sourceIds": []
    }
  ]
}
```

## 输出与错误

`validate` 返回 JSON `{valid, pages, assets}`，不写文件。`build` 返回 `{output, index, pages}`。成功退出 0；输入、文件或运行错误退出 1，命令参数错误退出 2，stderr 给出字段或文件原因。`serve` 前台长驻，第一行返回 `{url,pid,directory,stop}`；Ctrl-C 正常停止。

输出文件：`index.html`、`reader.css`、`reader.js`、`task.json`、`manifest.json` 与 `assets/`。正文及关联文字内嵌进页面，不依赖 fetch 或外网；原始文字与图片也单独保留。task.json 保持输入合同，path 改为成果内相对路径。manifest 保存 schemaVersion、templateVersion、原始输入摘要及复制素材 SHA-256。

生成失败不留下最终目录，已有输出拒绝覆盖。生成器用同目标的临时锁串行化生成；进程被强杀可能留下 `.gallery-lock` 和 `.gallery-*`，核对没有相同目标构建在运行后，才清理这些本次临时文件或换新输出目录。不要删除旧成果绕过覆盖检查。

未知版本拒绝；不自动迁移。每份报告带模板副本，后续升级不改变旧报告。生成器只处理显式列出的素材，不自动爬取来源、执行命令或读整个历史。

`serve` 只绑定 `127.0.0.1`，只允许清单中的文件，不开放目录列表和写接口；根目录越界及符号链接逃逸均拒绝。素材路径不接受绝对路径、`..`、反斜线、冒号或远程 URL。页面文本转义显示，不支持任务传入 HTML。输入输出根目录应由当前用户控制，不将此本机工具部署为多用户公共服务。
