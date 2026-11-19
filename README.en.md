# MuseReel

[简体中文](README.md)

MuseReel is an AI short-drama production tool for personal use. It covers script rewriting, character and scene design, storyboards, video generation, and final export. It runs in a browser or as an Electron desktop app.

## Local development

Install Node.js 22 or 24, npm, and Git. Video compositing uses FFmpeg and FFprobe. If dependency installation does not supply working binaries, install both tools and add them to `PATH`.

```bash
git clone https://github.com/784238119/MuseReel.git
cd MuseReel
npm ci --prefix backend
npm ci --prefix frontend
```

Run `npm run dev:backend` and `npm run dev:frontend` in separate terminals. Open the [local workspace](http://localhost:3013), configure the text, image, and video services in Settings, then create a project. The backend listens on port 5679, and the frontend dev server proxies API and static asset requests.

## Desktop builds

```bash
npm ci --prefix desktop
npm run build:frontend
npm run dev:desktop
```

On macOS, run `npm run dist` to create local macOS installers. Run `npm run dist:win --prefix desktop` to build the Windows installer. Artifacts are written to `desktop/release/`.

## Run as a single service

```bash
npm run build:frontend
FRONTEND_DIST="$PWD/frontend/.output/public" npm start --prefix backend
```

Open the [local workspace](http://localhost:5679). For Docker, run `docker compose up -d --build` to build from this checkout. Docker stores project data in a named Compose volume.

## License and attribution

MuseReel is derived from [chatfire-AI/huobao-drama](https://github.com/chatfire-AI/huobao-drama), with changes to the project branding, documentation, and build artifact names. The project retains the [CC BY-NC-SA 4.0](LICENSE) license.
