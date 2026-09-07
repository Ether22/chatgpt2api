# Issue tracker: Local Markdown

任务和规格保存在本仓库 `.scratch/` 下。

## 文件约定

- 每个功能一个目录：`.scratch/<feature-slug>/`。
- 规格：`.scratch/<feature-slug>/spec.md`。
- 实施任务：`.scratch/<feature-slug>/issues/<NN>-<slug>.md`，
  从 01 编号，每个任务独立成文件。
- 评论和讨论追加到任务文件末尾的 `## Comments` 下。

## 操作约定

- 发布任务：按上述路径创建 Markdown 文件，按需创建目录。
- 获取任务：读取用户指定的文件；仅提供编号时，在对应功能目录查找。
- 更新任务：编辑对应文件，保留已有讨论。
