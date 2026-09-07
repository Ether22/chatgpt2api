# 07 北京时间

状态：待实施，仅文档。规格：[R14](../spec.md)。依赖：可独立推进；完成后核对 01–06 新增业务日期。

## 工作范围

- 界面、业务 API、日志及业务文件日期统一北京时间，覆盖图片、账号、用户密钥、备份及关联功能。
- 浏览器格式化显式指定时区，业务日期输出无歧义；修正无条件追加 Z 等现有假设。
- 复用现有时间工具/标准库；内部瞬时与时差计算保持正确，JWT 时间戳、AWS/R2 签名及外部协议强制 UTC 的字段不转换。
- 新写入遵循统一约定，不新增历史日期迁移工程。

## 验收

- 浏览器和服务器分别切换不同时区，图片、账号、密钥、日志及备份文件名显示相同北京时间；验证午夜日期边界。
- token 有效期、任务耗时与协议 UTC 语义不变，不出现二次加八小时。

## 核查入口

`services/account_service.py`、`services/auth_service.py`、`services/image_task_service.py`、`services/image_storage_service.py`、`services/backup_service.py`、`services/log_service.py`、`web/src/app/` 日期展示。
