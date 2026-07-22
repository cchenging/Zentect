# 贡献指南

## 分支策略

| 分支 | 用途 |
|---|---|
| `main` | 稳定分支，始终保持可构建、可运行 |
| `feat/<name>` | 新功能开发 |
| `fix/<name>` | Bug 修复 |

工作流：`feat/xxx` → 开发完成 → 提 PR 到 `main` → Code Review → 合并。

## 提交规范

本项目使用 [Conventional Commits](https://www.conventionalcommits.org/)，由 commitlint 强制执行。

格式：`type(scope?): subject`

### Type 类型

| Type | 说明 | 示例 |
|---|---|---|
| `feat` | 新功能 | `feat(editor): 添加时间轴缩放手势` |
| `fix` | Bug 修复 | `fix(export): 修复导出时字幕偏移` |
| `docs` | 文档变更 | `docs: 更新架构文档` |
| `style` | 代码格式（不影响逻辑） | `style: 统一缩进为 2 空格` |
| `refactor` | 重构 | `refactor(pipeline): 提取 TTS 策略接口` |
| `perf` | 性能优化 | `perf: 帧抽取改用 Worker 并行` |
| `test` | 测试 | `test: 补充导出管线单元测试` |
| `chore` | 构建/工具变更 | `chore: 升级 electron-vite 到 5.0` |
| `revert` | 回滚 | `revert: 回滚 feat:xxx` |
| `ci` | CI 配置 | `ci: 添加 Windows 构建流水线` |
| `build` | 构建系统变更 | `build: 切换打包工具到 electron-builder` |

### Scope 建议

`main` `renderer` `editor` `pipeline` `export` `models` `docs` `deps`

详细说明见 [Git 提交规范](docs/03_Engineering/git-commit-spec.md)。

## Pull Request 流程

1. 从 `main` 拉取最新代码，创建功能分支
2. 开发并自测，确保 `pnpm lint` 和 `pnpm typecheck` 通过
3. 提交代码，遵循上述提交规范
4. 推送分支，在 GitHub 创建 PR
5. 至少 1 位成员 Review 并 Approve
6. CI 检查通过（lint + typecheck + test）后合并

## PR 自检清单

- [ ] 代码通过 `pnpm lint` 无报错
- [ ] 代码通过 `pnpm typecheck` 无新增类型错误
- [ ] 新增功能有对应测试（如适用）
- [ ] 公共层新增代码已通过准入审核（见 [common-layer-policy](docs/03_Engineering/common-layer-policy.md)）
- [ ] 涉及 IPC 变更已更新 [ipc-contracts](docs/02_Architecture/ipc-contracts.md)
- [ ] 涉及数据库变更已添加迁移文件
- [ ] 文档已同步更新

## Code Review 要点

- 业务逻辑正确性
- 错误处理完整性（使用 `AppError` + `ErrorCode`）
- 不跨进程直接调用 API（必须走 IPC）
- Store 写入不越权（参考架构文档写入者矩阵）
- 工具函数准入条件（参考 common-layer-policy）

## 环境配置

- [本地环境搭建](docs/04_Environment/local-setup.md)
- [模型部署](docs/04_Environment/model-hydration.md)
