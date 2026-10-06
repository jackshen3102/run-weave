# 手机远程桌面：悬浮操作原型

2026-10-06 用户确认实施的交互基准，原型已冻结为历史产物。原型数据和系统键盘仍为模拟；当前实现以 remote-desktop-ios 和 app-ios 源码为准。

## 简报

目标：撤去标题、状态和底部操作占用的固定行，让远程画布使用全部可用区域；键盘仍一步可达。

主要流程：操作桌面 → 悬浮胶囊 → 会话菜单或键盘 → 收起后继续操作。

影响模块：`packages/remote-desktop-ios` 的 RemoteDesktopView、RemoteNativeSurface，以及 `packages/app-ios` 的 RemoteDesktopCover。

## 打开

在 Runweave 的 Prototypes 页面打开本目录。独立预览：

```bash
python3 -m http.server 6188 --bind 127.0.0.1 --directory docs/prototypes/remote-desktop-mobile
```

- 产品画面：<http://127.0.0.1:6188/index.html>
- 三状态评审画板：<http://127.0.0.1:6188/review.html>
- 菜单：`index.html?state=menu`
- 键盘：`index.html?state=keyboard`
- 收起：`index.html?state=collapsed`
- 完整桌面：`index.html?zoom=1`
- 重连提示：`index.html?connection=reconnecting`

桌面样例尺寸为 1100 × 688，默认模拟已放大到 200% 的会话，菜单里的“适应屏幕”回到完整桌面。缩放通过鼠标滚轮预览。键盘显示时只平移画面，不改变缩放比例。系统安全区域保留；没有应用顶部导航栏。

## 功能分类账

| 类别     | 内容                                                                                      |
| -------- | ----------------------------------------------------------------------------------------- |
| 产品核心 | 悬浮键盘和菜单入口、拖动贴边并记忆位置、收起与展开工具栏                                  |
| 产品核心 | 模式选择并记忆、适应屏幕、右击入口、统计、手势帮助、结束会话                              |
| 产品核心 | 文本草稿、发送、收起键盘、按需展开快捷键、重连状态提示                                    |
| 原型辅助 | review.html 的三机画板、标题、编号、说明和外框；带 data-prototype-helper 标记，不进入产品 |
| 原型辅助 | URL 状态参数、模拟 Mac 内容、连接数据、HTML 绘制的系统状态栏和键盘                        |

## 设计边界

采用：全屏画布 + 始终可发现的悬浮入口；菜单和键盘按需覆盖。

暂不采用：上下双工具栏、只有隐藏手势的入口、自动完全消失的工具栏、打开键盘后压缩桌面。

这不是远控实现：不连接 Mac，不发送真实键盘和鼠标事件。右击仅显示样例菜单，发送仅把文字追加到样例终端；快捷键只显示本地反馈。统计为固定样例数据，结束/重新连接仅切换本地状态，不代表新增了产品连接协议。多指手势、真实输入法、VoiceOver、系统旋转行为需在后续原生实现中验证。HTML 数字和字母键仅用于预览输入，不代替 iOS 系统键盘。

浮层、模式与缩放的行为可以在浏览器评审；浏览器原型验收不等于 iPhone 验收。

## 验证记录

已用仓库固定版本的 Playwright CLI 在浏览器执行交互检查（393 × 852）：菜单开关、输入模式切换、统计展开、适应屏幕、键盘前后画面宽高不变、模拟发送、数字键、快捷键、工具栏收起/展开、拖到左侧贴边、菜单不越界、结束/重新连接，全部通过。

`pnpm docs:check` 通过。评审图为 [prototype-preview.png](./prototype-preview.png)，来自浏览器 HTML 原型，非 iPhone 真机截图。

本机 Profile resolver 返回 `Unknown browser profile option: --instance`。按 playwright-cli 技能的旧版本回退规则连接终端已提供的 CDP，只新建原型标签页，保留既有标签；未声称完成 Profile 选择验证。
