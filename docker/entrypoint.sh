#!/bin/sh
# 容器入口：workspace 模板 copy-once 到数据卷（与桌面版 userData 同一语义），然后启动后端
set -e

if [ ! -e /app/data/workspace/.template-version ]; then
  mkdir -p /app/data/workspace
  cp -a /app/workspace-template/. /app/data/workspace/
  touch /app/data/workspace/.template-version
fi

# 已初始化的数据卷只补小说技能，保留用户编辑过的文件。
if [ ! -e /app/data/workspace/.novel-skills-v1 ]; then
  for skill in novel-writer novel-splitter; do
    skill_dir="/app/data/workspace/skills/$skill"
    if [ ! -e "$skill_dir/SKILL.md" ]; then
      mkdir -p "$skill_dir"
      cp -n "/app/workspace-template/skills/$skill/SKILL.md" "$skill_dir/SKILL.md"
    fi
  done
  touch /app/data/workspace/.novel-skills-v1
fi

cd /app/backend
exec node_modules/.bin/tsx src/index.ts
