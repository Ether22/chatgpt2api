# 生图工作流改造：已批准的执行任务

用户于 2026-09-08 批准十八项拆分及阻塞关系，随后明确授权进入本地代码修改、测试、审查、提交和集成阶段。唯一进度与调度记录见 [PROGRESS](PROGRESS.md)；十八项现均已完成本地实施、双轴审查、集成与验收；每票报告见下表。

## 来源与使用方式

- 唯一父规格：[生图工作流、服务端历史与账号管理](../image-workflow-upgrade/spec.md)。
- 保留的核查与确认：[讨论记录](../image-workflow-upgrade/research-notes.md)。
- 批准的拆分：[拆分与验收边界](../image-workflow-upgrade/ticket-breakdown-draft.md)。
- 父规格、原八项较粗的主题文件及其已有记录均保留不改。本目录是批准后的执行划分，原八项用于理解主题覆盖，不另行重复实施。
- 编号属于本目录；不要与原八项主题编号混用。依赖以各票 Blocked by 为准，只有前置票完成后才进入可执行前沿。
- 所有票继续遵循已经确认的测试方案、术语及领域决策。发布 ready-for-agent 不代表任务已完成。

## 任务清单

| 编号 | 任务 | Blocked by | 状态 |
| --- | --- | --- | --- |
| 01 | [Prompt 折叠、图片顺序与数量记忆](issues/01-readable-results-and-count.md) | None | 已完成 · [报告](reports/01.md) |
| 02 | [OAuth 弹窗底部操作可达](issues/02-oauth-dialog-accessibility.md) | None | 已完成 · [报告](reports/02.md) |
| 03 | [普通生图在服务器保存并跨浏览器恢复](issues/03-server-conversation-roundtrip.md) | None | 已完成 · [报告](reports/03.md) |
| 04 | [普通参考图生成与独立快照](issues/04-reference-upload-and-snapshots.md) | 03 | 已完成 · [报告](reports/04.md) |
| 05 | [同会话排队、并发、恢复与失败详情](issues/05-concurrent-queue-recovery-errors.md) | 04 | 已完成 · [报告](reports/05.md) |
| 06 | [共享 MD 与参考图导入区](issues/06-shared-md-imports.md) | 04 | 已完成 · [报告](reports/06.md) |
| 07 | [MD 结构解析、匹配预览与纠错](issues/07-md-preview-validation.md) | 06 | 已完成 · [报告](reports/07.md) |
| 08 | [选择 MD 条目并随上传进度生成](issues/08-selected-md-generation.md) | 05、07 | 已完成 · [报告](reports/08.md) |
| 09 | [重跑与复用持续归入原条目](issues/09-rerun-and-reuse-lineage.md) | 08 | 已完成 · [报告](reports/09.md) |
| 10 | [单张结果的真实删除与引用保护](issues/10-single-result-deletion.md) | 04 | 已完成 · [报告](reports/10.md) |
| 11 | [范围删除、迟到清理与批量性能](issues/11-scope-deletion-late-results.md) | 05、10 | 已完成 · [报告](reports/11.md) |
| 12 | [查看器下方操作与本轮直接下载](issues/12-viewer-round-downloads.md) | 08、10 | 已完成 · [报告](reports/12.md) |
| 13 | [服务器分页与大型图库按需浏览](issues/13-paged-gallery-browsing.md) | 03 | 已完成 · [报告](reports/13.md) |
| 14 | [所有结果的右侧定位导航与窄屏抽屉](issues/14-result-navigation.md) | 09、13 | 已完成 · [报告](reports/14.md) |
| 15 | [监控、禁用与可消费额度](issues/15-account-modes-and-quota.md) | None | 已完成 · [报告](reports/15.md) |
| 16 | [账号隐藏与组内拖拽排序](issues/16-account-visibility-order.md) | 15 | 已完成 · [报告](reports/16.md) |
| 17 | [账号只保留不物理删除](issues/17-disable-account-deletion.md) | None | 已完成 · [报告](reports/17.md) |
| 18 | [业务 API、界面、日志及文件日期统一北京时间](issues/18-beijing-business-time.md) | None | 已完成 · [报告](reports/18.md) |

## 最终交付状态

十八项前置依赖均已满足，无剩余待实施票。最终应用提交83a872a；验证范围与真实上游联调边界见 [VALIDATION](VALIDATION.md)。

## 覆盖与发布检查

- 覆盖正式规格全部 117 条用户故事，重复映射表示同一用户流程的不同阶段共同验收。
- 全部阻塞边指向较小编号；没有循环或多余的传递依赖。
- 每票同时交付其用户可见行为与相关验证；需要数据或接口时在该票内完成，不拆成只有后端或只有测试的横向票。
- 原八项主题覆盖关系：服务端归属对应 03/04/06/13；MD 导入对应 06/07/08；生成流水线对应 05/08；结果与导航对应 01/09/12/14；删除对应 10/11；账号对应 15/16/17；北京时间对应 18；OAuth 对应 02。
