# Zentect

本地优先的 AI 视频编辑工作站。将素材提取、脚本生成、TTS 配音、字幕合成集成为一条完整的离线管线。

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面框架 | Electron 39 + electron-vite 5 |
| 前端 | React 18 + TypeScript 5.3 + Tailwind CSS 4 |
| 状态管理 | Zustand + TanStack Query |
| 数据库 | SQLite (better-sqlite3) + IndexedDB (Dexie) |
| AI 引擎 | 本地 ONNX 模型（ASR/TTS/视觉） + 云端 API 回退 |
| 媒体处理 | FFmpeg (sharp) |

## 快速开始

### 系统要求

- Windows 11
- Node.js ≥18（推荐 22 LTS）
- pnpm
- Python 3.x（TTS 引擎依赖）
- CUDA 驱动（GPU 加速，可选）

### 安装与运行

```bash
# 克隆项目
git clone <repo-url>
cd Zentect

# 安装依赖
pnpm install

# 下载 AI 模型（详见 docs/04_Environment/model-hydration.md）

# 启动开发环境
.\dev.ps1
# 或简单启动
.\dev.bat
```

详细步骤见 [本地环境搭建指南](docs/04_Environment/local-setup.md)。

## 项目结构

```
Zentect/
├── src/
│   ├── main/           # Electron 主进程
│   │   ├── controllers/  # IPC 控制器
│   │   ├── engine/       # AI + 媒体引擎
│   │   ├── database/     # SQLite 迁移与 Repository
│   │   ├── services/     # 业务服务层
│   │   └── core/         # 崩溃报告/遥测/日志
│   ├── renderer/        # React 渲染进程
│   │   └── src/
│   │       ├── api/      # IPC 调用封装
│   │       ├── pages/    # 页面组件
│   │       └── modules/  # 功能模块
│   └── shared/          # 共享类型与契约
│       ├── types/        # TypeScript 类型定义
│       └── contracts/    # 核心接口契约
├── resources/
│   └── models/          # AI 模型文件（不进 Git）
├── docs/                # 开发文档（详见 docs/README.md）
└── delivery/            # 交付文档集（不进 Git）
```

## 文档

- [文档导航与缺口追踪](docs/README.md)
- [架构总览](docs/02_Architecture/overview.md)
- [IPC 通道契约](docs/02_Architecture/ipc-contracts.md)
- [数据库设计](docs/02_Architecture/database-design.md)
- [安全设计](docs/02_Architecture/security-design.md)
- [本地环境搭建](docs/04_Environment/local-setup.md)
- [Git 提交规范](docs/03_Engineering/git-commit-spec.md)
- [贡献指南](CONTRIBUTING.md)

## 脚本

| 命令 | 用途 |
|---|---|
| `pnpm dev` | 启动开发服务器 |
| `pnpm build` | 生产构建 |
| `pnpm lint` | ESLint 检查 |
| `pnpm format` | Prettier 格式化 |
| `pnpm typecheck` | TypeScript 类型检查 |
| `pnpm test` | 运行测试 |
| `pnpm build:win` | 打包 Windows 安装包 |
