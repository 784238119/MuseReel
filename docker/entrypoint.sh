#!/bin/sh
# 容器入口：workspace 模板 copy-once 到数据卷（与桌面版 userData 同一语义），然后启动后端
set -e

APP_ROOT=${APP_ROOT:-/app}
WORKSPACE_TEMPLATE=${WORKSPACE_TEMPLATE:-$APP_ROOT/workspace-template}
WORKSPACE_DATA=${WORKSPACE_DATA:-$APP_ROOT/data/workspace}

if [ ! -e "$WORKSPACE_DATA/.template-version" ]; then
  mkdir -p "$WORKSPACE_DATA"
  cp -a "$WORKSPACE_TEMPLATE/." "$WORKSPACE_DATA/"
  touch "$WORKSPACE_DATA/.template-version"
fi

file_digest() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    printf 'unavailable\n'
  fi
}

# v2 补齐新技能并迁移未编辑的旧版 novel-writer，保留用户自定义文件。
if [ ! -e "$WORKSPACE_DATA/.novel-skills-v2" ]; then
  for skill in novel-writer novel-splitter creative-agent; do
    skill_dir="$WORKSPACE_DATA/skills/$skill"
    if [ ! -e "$skill_dir/SKILL.md" ]; then
      mkdir -p "$skill_dir"
      cp "$WORKSPACE_TEMPLATE/skills/$skill/SKILL.md" "$skill_dir/SKILL.md"
    fi
  done

  novel_writer="$WORKSPACE_DATA/skills/novel-writer/SKILL.md"
  if [ "$(file_digest "$novel_writer")" = "a0f249a11abd86d216ca6dc1f8a528d092760176e756082d4b6ef3a00384447c" ]; then
    cp "$WORKSPACE_TEMPLATE/skills/novel-writer/SKILL.md" "$novel_writer"
  fi
  touch "$WORKSPACE_DATA/.novel-skills-v2"
fi

cd "$APP_ROOT/backend"
exec node_modules/.bin/tsx src/index.ts
