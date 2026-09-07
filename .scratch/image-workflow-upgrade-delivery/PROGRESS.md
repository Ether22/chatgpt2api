# 生图工作流实施进度

## 当前授权与唯一调度入口

2026-09-08 用户明确取消“先不修改代码”，授权按已确认规格进行本地代码修改、测试、审查、提交和集成；要求每票一个新 Codex 对话、独立 Git worktree 与分支，由当前主对话统一调度到十八项完成。此前规格或任务中的“仅发布/不改代码”是当时阶段记录，已被本次明确授权取代。

本文件是唯一进度表，由主对话维护。正式需求仍以已确认规格和领域决策为准，不因进入实施而改变。工作树中的实施对话只维护自己的报告/任务评论，不改本进度表、不自行集成或合并其他票。

- 主对话：01a07c8d-1fed-7362-8ace-418f3f4cfb0e。
- 集成分支：codex/image-workflow-integration。
- 原始代码起点：dc105e5。
- 统一文档基线：2e3cba11c3d6e85a0daba22b4d4292cecd95af4d（37 个已确认文档文件，工作区干净后派发）。
- 首批：01 Astra medium、02 Astra medium、15 Astra high；最多同时三个实施对话。
- 前置票只有在主对话集成并验证后才算满足；新票从最新集成基线创建独立工作树。
- 正式执行票在本目录 issues 下，原八项粗分主题仅作背景，不重复实施。
- 子对话遵循 implement、已确认测试边界与 code-review；审查固定点为各自派发基线 SHA，无需再次问用户。
- 测试仅使用各工作树自己的数据、配置及隔离端口，禁止使用主目录的实际账号/图片数据。默认前端端口 43100 + 票号×10，若需后端用该端口 + 1。
- Windows 后台服务使用隐藏窗口。不要提交数据目录、凭据、依赖安装输出或构建缓存。
- 用户给出的两个漏分隔符路径已解析为项目内 .scratch/image-workflow-upgrade-delivery/README.md 和用户目录 .agents/skills/implement/SKILL.md。

## 任务进度

| 票 | 标题 | 阻塞票 | Codex 对话 | 分支 | 模型/强度 | 状态 | 实施提交 | 集成提交/验证 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 01 | Prompt 折叠、图片顺序与数量记忆 | 无 | client-new-thread:b2aef621-1ed9-4927-9ca7-2083258dc0fe（待实际 ID 回报） | codex/image-task-01 | gpt-6-astra / medium | 工作树已建立 | — | — |
| 02 | OAuth 弹窗底部操作可达 | 无 | 01a07cd9-5bba-7003-ac8b-728c6f60fbad | codex/image-task-02 | gpt-6-astra / medium | 实施中 | — | — |
| 03 | 普通生图在服务器保存并跨浏览器恢复 | 无 | 待创建 | codex/image-task-03 | gpt-6-astra / high | 待调度 | — | — |
| 04 | 普通参考图生成与独立快照 | 3 | 待创建 | codex/image-task-04 | gpt-6-astra / high | 待调度 | — | — |
| 05 | 同会话排队、并发、恢复与失败详情 | 4 | 待创建 | codex/image-task-05 | gpt-6-astra / high | 待调度 | — | — |
| 06 | 共享 MD 与参考图导入区 | 4 | 待创建 | codex/image-task-06 | gpt-6-astra / high | 待调度 | — | — |
| 07 | MD 结构解析、匹配预览与纠错 | 6 | 待创建 | codex/image-task-07 | gpt-6-astra / high | 待调度 | — | — |
| 08 | 选择 MD 条目并随上传进度生成 | 5, 7 | 待创建 | codex/image-task-08 | gpt-6-astra / high | 待调度 | — | — |
| 09 | 重跑与复用持续归入原条目 | 8 | 待创建 | codex/image-task-09 | gpt-6-astra / high | 待调度 | — | — |
| 10 | 单张结果的真实删除与引用保护 | 4 | 待创建 | codex/image-task-10 | gpt-6-astra / high | 待调度 | — | — |
| 11 | 范围删除、迟到清理与批量性能 | 5, 10 | 待创建 | codex/image-task-11 | gpt-6-astra / high | 待调度 | — | — |
| 12 | 查看器下方操作与本轮直接下载 | 8, 10 | 待创建 | codex/image-task-12 | gpt-6-astra / medium | 待调度 | — | — |
| 13 | 服务器分页与大型图库按需浏览 | 3 | 待创建 | codex/image-task-13 | gpt-6-astra / high | 待调度 | — | — |
| 14 | 所有结果的右侧定位导航与窄屏抽屉 | 9, 13 | 待创建 | codex/image-task-14 | gpt-6-astra / high | 待调度 | — | — |
| 15 | 监控、禁用与可消费额度 | 无 | 01a07cd9-5e81-7a41-9890-e40f01e0855a | codex/image-task-15 | gpt-6-astra / high | 实施中 | — | — |
| 16 | 账号隐藏与组内拖拽排序 | 15 | 待创建 | codex/image-task-16 | gpt-6-astra / medium | 待调度 | — | — |
| 17 | 账号只保留不物理删除 | 无 | 待创建 | codex/image-task-17 | gpt-6-astra / high | 待调度 | — | — |
| 18 | 业务 API、界面、日志及文件日期统一北京时间 | 无 | 待创建 | codex/image-task-18 | gpt-6-astra / high | 待调度 | — | — |

## 修改范围与调度约束

- 01：生图页面、图片结果与编辑框组件；与 03 共用生图页面，故 03 必须等 01 集成。01 不改账号代码或公共 Dialog。
- 02：账号导入弹窗局部布局；不改公共 Dialog、账号列表页或账号接口，避免与 15 重叠。
- 15：账号编辑/列表、账号 API/服务、消费资格与模型能力统计及相关验证；不改账号导入弹窗。
- 15 与 17 都会触及账号服务，错开。16 根据 15 新模式实现；再评估与 17 的实际范围。
- 18 涉及跨模块业务日期，安排在其他票稳定集成后独立推进并进行最终日期复核。
- 后续每票派发前重新核对实际修改范围；无阻塞依赖不等于可并行。对同文件/接口的冲突风险优先错开，不能只按 DAG 派发。

## 检查与集成记录

- 已检查：工作区无已跟踪代码改动，当前未提交内容仅为本轮规格、任务、AGENTS.md、领域/代理文档；原运行配置与 data 保持不动。
- 已检查：首批 01/02/15 在上述范围约束下可并行。
- 01 工作树：C:/Users/ForestHill/.codex/worktrees/d9c8/chatgpt2api；02：C:/Users/ForestHill/.codex/worktrees/e6ce/chatgpt2api；15：C:/Users/ForestHill/.codex/worktrees/0dd2/chatgpt2api。三者均从共同基线创建且已拥有独立分支。
- Git 无作者配置，本次自动化提交使用命令级 Codex <codex@local>，不修改全局身份。
- 15 的消费资格核查补充 editable-file 的 PPT/PSD 账号选择与模型目录能力推断，不与 01/02 保留范围冲突。
- 主对话准备 .venv/runtime 下 Python3.13 与 uv.lock 锁定依赖，解释器可共用读取；每个工作树自己的数据、配置、端口及构建输出保持隔离。完整离线测试不能调用现有 localhost:8000 真实联调脚本。
