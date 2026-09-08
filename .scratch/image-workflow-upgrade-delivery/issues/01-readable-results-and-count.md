# 01: Prompt 折叠、图片顺序与数量记忆

**What to build:** 普通生图页面可折叠长 Prompt，图片按行阅读；首次默认 4 张，纯数字 1–100 且保留后续选择。

**Blocked by:** None (can start immediately).

**Status:** integrated-and-verified

**Parent:** [生图工作流、服务端历史与账号管理规格](../../image-workflow-upgrade/spec.md)

**User stories:** US1、US2、US3、US29、US30、US33。

- [x] 不同列数下按 1、2、3、4 阅读，折叠后参考图与任务标识仍可见。
- [x] 非法或越界数量不能提交，已有手动选择不被上传或重新渲染重置。
- [x] 通过现有普通生图入口完成浏览器验收，不等待新 MD 功能。

## Comments

2026-09-08：用户已批准本票所在的十八项拆分及阻塞关系。本轮仅发布任务，尚未实施应用代码。此前相关核查和确认保留在父规格的讨论记录中。

2026-09-08 主对话最终集成：本票已在 codex/image-workflow-integration 集成并验证完成。详见[验收报告](../reports/01.md)及[统一进度](../PROGRESS.md)；以上发布/阶段状态保留为历史记录。
