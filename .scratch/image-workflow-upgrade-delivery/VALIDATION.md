# 隔离验收环境与原始基线

仅使用自己的工作树、假账号和临时存储，禁止从主目录运行会导入应用配置的测试。主目录的实际 data/config 不参与验收。

## 已准备的运行时

- Python：`C:/Users/ForestHill/Documents/chatgpt2api/.venv/runtime/Scripts/python.exe`，3.13.15；已执行 `uv sync --frozen --group dev`，另安装现有数据库测试需要的 pytest 9.1.1，仅测试环境变化。
- Node：`C:/Program Files/nodejs/node.exe`；npm：同目录 `npm.cmd`。
- 各工作树独立安装 web/package.json 中已有依赖，可用 `npm install --no-package-lock --ignore-scripts`，不提交缓存或生成的锁文件。
- 后端旧 HTTP 测试固定使用 `Bearer chatgpt2api`，执行完整套件时设置 `CHATGPT2API_AUTH_KEY=chatgpt2api`，该值仅用于隔离假数据；本票新增专用测试可使用其自己的受控身份。
- 前端须单独执行 `node node_modules/typescript/bin/tsc --noEmit --pretty false`；当前 Next 构建设置会跳过类型错误，因此只通过 build 不够。

## 离线测试范围

`test/test_*.py` 中以下文件属于真实服务手动联调，不自动运行：

- test_v1_chat_completions.py、test_v1_messages.py、test_v1_responses.py、test_v1_images_generations.py、test_v1_images_edits.py。
- test_codex_4k.py、test_generations.py、test_generations_url.py、test_gpt_ppt.py、test_gpt_psd.py、test_gpt_search.py、test_image.py、test_image_output_tokens.py。
- test_v1_models.py 混合离线和真实 HTTP 测试；主对话基线只运行两个带 mock 的模型目录断言：`test_list_models_only_returns_image_models_backed_by_account_types` 与 `test_list_models_does_not_return_codex_models_for_web_plus_accounts`。

其余测试文件以及新增的受控测试纳入离线验收。远程存储、上游生成、OAuth 等必须以受控边界替代，不以运行真实消费脚本冒充验收。

## 基线结果

统一文档基线 2e3cba1（原始应用代码 dc105e5）在主对话隔离工作树验证：

- 后端 138 项：133 通过、5 失败。首次自定义测试键引起的 14 项 401 已通过匹配固定测试键消除，未修改应用鉴权。
- `test_poll_waits_for_generated_asset_ids_to_settle` 未显式启用当前 check/settle 开关，首次命中即返回，与旧用例的三轮预期不同；交票05结合轮询恢复行为核查。
- `test_v1_images_edits_json.py` 四项旧断言不匹配已有接口：默认文件名、缺图错误文案、允许远程 URL 的行为。交票04对照现有公开接口核查，并以受控读取替代远程访问。
- 前端 TypeScript 检查通过；生产构建通过，11 个静态页面成功生成。

这五项是集成前已复现的问题，首批局部票应报告而不扩改无关后端。相关后续票必须解决并记录依据，最终整体验收不能仅以“基线已有”跳过。
