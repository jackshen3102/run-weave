# 手机终端加号菜单原型

2026-09-30 的历史交互原型，仅供查看输入框外部布局和菜单。当前产品行为以
[原生 iOS 客户端](../../architecture/app-mobile.md#全局快捷回复输入策略)及源码为准。
原型内的指令列表、填入/后台模式切换和通用文件入口未进入产品；“快捷指令”在产品中打开
现有快捷回复库，“添加图片”沿用图片草稿流程。参考截图见
[现有快捷回复页面](existing-quick-replies-reference.png)。

可从 Runweave 的 Prototypes 浏览器打开本目录，或在仓库根目录运行：

```bash
python3 -m http.server 6198 --bind 127.0.0.1 --directory docs/prototypes/mobile-terminal-actions
```

打开 `http://127.0.0.1:6198/`；`?gallery=1` 为三态总览，预览图见
[prototype-preview.png](prototype-preview.png)。页面使用内存 mock，不连接真实 API、相册或终端；
浏览器中的交互不能证明原生 iOS 与后台运行验收通过。
