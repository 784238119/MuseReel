# MuseReel 开发说明

启动和安装步骤见 [项目首页](../README.md)。

| 目录 | 职责 |
| --- | --- |
| `frontend/` | Nuxt 3 单页应用。动态路由由 `nuxt.config.ts` 注册，短剧工作台位于 `app/views/drama/`。 |
| `backend/` | Hono API、SQLite、Mastra Agent、媒体任务和 FFmpeg 导出。Agent 提示词和 Skill 模板位于 `workspace/`。 |
| `desktop/` | Electron 主进程、preload、运行时资源、安装器和诊断脚本。主进程会启动后端并等待健康检查通过，再加载前端。 |
| `docker/` | 容器启动脚本，负责准备工作区模板和启动后端。 |

## 本地验证

```bash
npm run typecheck --prefix backend
npm run build:frontend
npm run build:main --prefix desktop
npm run build:backend --prefix desktop
```

前端静态产物位于 `frontend/.output/public/`。桌面开发和打包读取该目录，单服务运行默认读取 `frontend/dist/`。

## 数据和配置

AI 服务通过设置页维护，存入 SQLite。服务端可用 `SQLITE_PATH` 指定数据库位置，用 `WORKSPACE_PATH` 指定 Agent 工作区，用 `FFMPEG_BIN`、`FFPROBE_BIN` 覆盖媒体工具路径。

本地默认数据库位于 `data/` 目录。桌面版和开发版分别保留独立的用户数据目录，安装 MuseReel 后可继续使用已有数据。

兼容网关的视频交付和任务恢复流程见 [视频交付](video-delivery-implementation.md)。
