#!/usr/bin/env bash
#
# Monk Harness 远程一键安装助手。
#
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/yaoleifly/monk-harness/main/scripts/install.sh | bash
#
set -euo pipefail

MONK_DIR="${MONK_DIR:-$HOME/.monk-harness}"
REPO_URL="https://github.com/yaoleifly/monk-harness.git"

echo "=================================================="
echo "          Monk Harness 一键安装助手               "
echo "=================================================="

# 1. 检查 dsh 与 pnpm
if ! command -v dsh >/dev/null 2>&1; then
  cat >&2 <<'EOF'
错误：找不到 `dsh` 命令。

请先安装 DeepSeek Harness：
    npm install -g @deepseek-ai/dsh
EOF
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  cat >&2 <<'EOF'
错误：找不到 `pnpm` 命令。

请先安装 pnpm：
    npm install -g pnpm
EOF
  exit 1
fi

# 2. 克隆/更新仓库到 ~/.monk-harness
if [ -d "$MONK_DIR/.git" ]; then
  echo "-> 更新已有 Monk Harness 仓库: $MONK_DIR"
  (cd "$MONK_DIR" && git pull --rebase)
else
  echo "-> 克隆 Monk Harness 仓库到: $MONK_DIR"
  git clone "$REPO_URL" "$MONK_DIR"
fi

# 3. 运行安装与重绑定
echo "-> 安装并配置 Monk Profile..."
(cd "$MONK_DIR" && bash scripts/install-into-dsh.sh)
