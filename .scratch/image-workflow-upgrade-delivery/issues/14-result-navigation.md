# 14: 所有结果的右侧定位导航与窄屏抽屉

**What to build:** 普通、MD、重跑和复用按条目、次数、图片导航，可折叠、跨页定位并同步手动滚动位置。

**Blocked by:** [09: 重跑与复用持续归入原条目](09-rerun-and-reuse-lineage.md)；[13: 服务器分页与大型图库按需浏览](13-paged-gallery-browsing.md).

**Status:** integrated-and-verified

**Parent:** [生图工作流、服务端历史与账号管理规格](../../image-workflow-upgrade/spec.md)

**User stories:** US58、US59、US60、US61、US62、US63、US64、US65、US66、US91、US92。

- [x] MD 用文档标识/名称，普通从 Prompt 本地取短名，不调用 AI；复用保持原条目与次数，不增加层级。
- [x] 父项名称定位最新轮，箭头只折叠；收起仍提示当前位置，定位与手动滚动高亮一致。
- [x] 未加载目标先加载对应分页；导航本身只取轻量信息，不预加载全部图片。
- [x] 右栏滚动不带动中间结果区，底部内容可达；窄屏抽屉同样支持定位。

## Comments

2026-09-08：用户已批准本票所在的十八项拆分及阻塞关系。本轮仅发布任务，尚未实施应用代码。此前相关核查和确认保留在父规格的讨论记录中。

2026-09-08 主对话最终集成：本票已在 codex/image-workflow-integration 集成并验证完成。详见[验收报告](../reports/14.md)及[统一进度](../PROGRESS.md)；以上发布/阶段状态保留为历史记录。
