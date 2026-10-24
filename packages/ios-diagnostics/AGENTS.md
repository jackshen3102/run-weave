# iOS 操作诊断

两个原生宿主共用的有界本地操作记录，只依赖 Foundation。宿主提供版本、环境、Clarity
关联和固定事件回调；本包不导入业务 App、不发送网络请求、不读取凭据。

- 不记录正文、URL、附件名或错误描述；新增上下文字段必须加入显式白名单。
- `confirmed` 表示业务响应已校验；`state_updated` 表示模型状态已提交；`ui_updated`
  只能由实际界面生命周期记录。analytics 的 confirmed 仅指本地 SDK 接受初始化或标签，
  不证明云端收录。
- 验证入口：`swift build --package-path packages/ios-diagnostics`，随后构建并操作两个宿主。
