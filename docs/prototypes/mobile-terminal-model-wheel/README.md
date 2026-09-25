# 当前手机终端模型切换原型

> 历史原型：用于记录模型切换交互设计，不代表当前产品行为。当前实现以原生 iOS 代码和 [终端状态架构](../../architecture/terminal-state.md) 为准。

本版不再另画手机终端，而是以当前原生 iOS 终端输入面板为基线增加模型切换。

## 基线

- 当前产品代码：`packages/app-ios/Sources/RunweaveIOS/Features/Terminal/Input/ComposerView.swift`
- 当前呈现方式：`TerminalComposerPresentation.swift` 的全屏半透明覆盖层，底部跟随系统键盘。
- 当前真实界面证据：`.runweave/local-quick-replies/runner/composer-03-attachments/` 下的 iOS 截图。
- 旧 `docs/prototypes/ios-terminal-layout/` 已在 README 中标注为历史原型，因此只用于理解演进，不照搬其常驻 dock。

## 本次新增

在现有 Composer 的底部工具行中，紧跟“添加图片”入口增加一个当前设置摘要，例如“GPT-6-Sol · 高”。点击后在命令输入卡片内完成一个连续的两步流程：

1. **选择模型**：打开普通可滚动列表，不附带搜索；点击模型后原位置直接进入下一步。
2. **选择推理强度**：只列出所选模型支持的档位；选中后关闭设置并回到命令输入。

推理强度页可返回模型页；关闭按钮可随时退出设置。切换模型时如果原推理档位不受支持，先回退到该模型默认档位，再让用户在第二步确认或改选。模型数据取自本机 Codex CLI `0.155.1` 的真实 `codex debug models` 结果；当前可见模型为 GPT-6-Astra、GPT-6-Sol、GPT-6-Luna、GPT-5.6-Sol、GPT-5.6-Terra、GPT-5.6-Luna 和 GPT-5.5。

其他结构保持当前手机产品：

- 顶部系统状态栏、覆盖式“输入终端”面板与关闭按钮；
- 机器 / 项目 / Agent 上下文；
- 现有输入卡片、附件、一键回复、快捷键、语音和发送入口；
- 系统键盘占位。

## 查看

```bash
python3 -m http.server 6197 --directory docs/prototypes/mobile-terminal-model-wheel
```

打开 `http://127.0.0.1:6197/`。

键盘为演示占位。模型目录和推理档位是本机当前 Codex catalog 快照，但会随 Codex 版本和账号变化。实际实现按当前面板的 provider/thread 读取设置，通过原有终端按键通道操作 Codex/TraeX 的 `/model` 菜单，并在提交后读取 thread 设置确认；原型中的模型列表不是固定产品目录。
