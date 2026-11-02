# 屏幕记录二期：时间回放图片原型（历史）

2026-10-31 的静态设计稿，不代表当前实现或交互验收结果。图片由图像工具生成，
桌面内容与记录均为示例，不含用户采集画面。

- [iOS 原型](ios-concept.png)：列表、回放和连接中断。
- [Mac 原型](mac-concept.png)：日期、时间列表、大画面与胶片带。

当前采集、原生回放、在线有效性及媒体包合同以
[ScreenJournal 入口](../../../packages/screen-recording-macos/README.md)为准；
手机连接与临时缓存见 [iOS 入口](../../../packages/app-ios/README.md#屏幕记录)。
图片中的应用分组、标题与固定时间段不作为现行合同：画面是所选显示器整屏，
前台应用只是元数据；当前记录按活动信号分组，手机通过当前 Backend 的既有认证在线查看。

播放、暂停、20×／40×／60×、逐帧与拖动需要实际原生交互取证；
静态图片不能替代[原生回放验收](../../testing/screen-recording/playback.testplan.yaml)。
旧实施计划从 Git 历史查阅。
