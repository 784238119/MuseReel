# MuseReel

[English](README.en.md)

MuseReel 是一款供个人使用的 AI 短剧制作工具，涵盖剧本改写、角色与场景设计、分镜制作、视频生成和成片导出。项目支持浏览器和 Electron 桌面端。

## 本地开发

准备 Node.js 22 或 24、npm 和 Git。视频合成依赖 FFmpeg 和 FFprobe，依赖安装未提供可用二进制时，可在系统中安装并加入 `PATH`。

```bash
git clone https://github.com/784238119/MuseReel.git
cd MuseReel
npm ci --prefix backend
npm ci --prefix frontend
```

分别在两个终端运行 `npm run dev:backend` 和 `npm run dev:frontend`。打开 [本地工作台](http://localhost:3013)，在「设置」中配置文本、图像和视频服务，再创建项目。后端监听 5679，前端开发服务器会代理 API 和静态资源请求。

## 桌面构建

```bash
npm ci --prefix desktop
npm run build:frontend
npm run dev:desktop
```

在 macOS 上运行 `npm run dist` 生成本地 macOS 安装包。运行 `npm run dist:win --prefix desktop` 生成 Windows 安装器。打包产物位于 `desktop/release/`。更多开发说明见 [开发文档](docs/development.md)。

## 单服务运行

```bash
npm run build:frontend
FRONTEND_DIST="$PWD/frontend/.output/public" npm start --prefix backend
```

打开 [本地工作台](http://localhost:5679)。使用 Docker 时，从仓库源码构建可运行 `docker compose up -d --build`。Docker 数据保存在 Compose 命名卷中。

## 许可证与来源

MuseReel 基于 [chatfire-AI/huobao-drama](https://github.com/chatfire-AI/huobao-drama) 改造，调整了项目品牌、文档和构建产物命名。项目沿用 [CC BY-NC-SA 4.0](LICENSE)。
