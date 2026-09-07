# Domain Docs

采用 single-context 布局。

## 探索代码前

- 阅读根目录 `CONTEXT.md`。
- 阅读 `docs/adr/` 中与当前工作相关的决策记录。
- 文件不存在时直接继续，不提示缺失，也不预先创建空文档。
  由 domain-modeling 技能在术语或决策明确时按需创建。

## 使用规则

- 涉及领域概念时，采用 `CONTEXT.md` 中定义的术语。
- 遇到未收录概念，先核实是否必要，再记录供 domain-modeling 补充。
- 建议与已有 ADR 冲突时，明确指出对应 ADR 和重新讨论的理由。
