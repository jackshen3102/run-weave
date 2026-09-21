# Push gateway

独立的通用 APNs 通知服务；不导入 Backend、App Server 或 Suiji 实现。
通知按 category 显式订阅；网关不识别电量阈值或轮次，业务规则与文案由调用方负责。
公共 HTTP 合同见 shared/push-notifications，投递与运维语义见 README.md。
私钥留在运行环境；发送凭据按 hostId 隔离，日志不得记录 token、Bearer 或密钥。
SQLite 事务保存订阅、撤销墓碑和发送结果；网络请求必须在持久化 claim 之后。
不新增单元测试，使用 `scripts/verify/device-monitor/` 的集成驱动和真机验收。
