# 验收材料与录屏证据

当前统一入口为 [`toolkit:acceptance`](../../plugins/toolkit/skills/acceptance/SKILL.md)。
用户提出要看本次改动或手机验收材料后，Agent 根据判断问题选择图文、视频或组合；
普通开发、测试和提交请求不默认制作材料。用户只要求原始录屏时只提供取证原片。

## 证据边界

- 材料展示实际观察，不能代替业务断言、真实交互或用户验收。
- 历史素材标明历史；Web、Electron、模拟器、浏览器设备模拟和真机分别记录来源。
- 浏览器录屏必须绑定当前实际操作的页面，采集与最终操作同时进行；
  换页面、录整个桌面或把离散状态拼成连续过程不能替代当前目标取证。
- 采样截图保留真实时间间隔，低帧率材料不证明动画流畅度或精确延迟；
  30 FPS 导出不会恢复原片未采到的动作。
- 本地生成、Agent 所在机器可访问、跨网络访问和物理手机播放是不同证据层。
- 只清理本任务拥有的会话，不停止用户应用；不因产物生成而自动提交或更新完成状态。

## 维护入口

取景、输入合同、制作命令、播放检查和链接规则只在统一 Skill 及其引用中维护：

- [图文合同](../../plugins/toolkit/skills/acceptance/references/gallery-contract.md)
- [浏览器采集](../../plugins/toolkit/skills/acceptance/references/capture.md)
- [视频制作](../../plugins/toolkit/skills/acceptance/references/video.md)
- [预览与检查](../../plugins/toolkit/skills/acceptance/references/delivery.md)

原来的三个 Skill 名称和已有脚本路径保留兼容转发。不要在兼容入口增加业务步骤、
默认账号、固定开发端口或另一套录屏循环；这些会使同一能力出现多个不同的执行合同。

素材和检查记录保存在任务独立的 `artifacts/verification-runs/` 中，默认不进入 Git。
本文不记录某次报告或某台手机的验证结果；以对应任务的原始证据和回执为准。
