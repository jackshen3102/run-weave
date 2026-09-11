# Push gateway

独立的 APNs provider；不导入 Backend、App Server 或 Suiji 实现。只接受固定电量模板。
私钥留在运行环境；发送凭据按 hostId 隔离，日志不得记录 token、Bearer 或密钥。
SQLite 事务保存订阅、撤销墓碑和发送结果；网络请求必须在持久化 claim 之后。
不新增单元测试，使用 `scripts/verify/device-monitor/` 的集成驱动和真机验收。
