#!/usr/bin/env bash
#
# Monk Harness 一键安装助手（针对 monk.party 用户优化）
#
# 用法：
#   curl -fsSL yaoleifly.github.io/monk-harness | bash
#   或带 Key 一键安装：
#   MONK_API_KEY=sk-... curl -fsSL yaoleifly.github.io/monk-harness | bash
#
set -euo pipefail

MONK_DIR="${MONK_DIR:-$HOME/.monk-harness}"
REPO_URL="https://github.com/yaoleifly/monk-harness.git"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"

echo "=================================================="
echo "          Monk Harness 一键安装助手               "
echo "=================================================="

# 1. 自动环境自愈：补齐 pnpm 与 dsh 依赖
if ! command -v pnpm >/dev/null 2>&1; then
  echo "-> 正在补齐 pnpm 依赖..."
  npm install -g pnpm 2>/dev/null || sudo npm install -g pnpm 2>/dev/null || true
fi

if ! command -v dsh >/dev/null 2>&1; then
  echo "-> 正在补齐 DeepSeek Harness (dsh) 依赖..."
  npm install -g @deepseek-ai/dsh 2>/dev/null || sudo npm install -g @deepseek-ai/dsh 2>/dev/null || true
fi

if ! command -v dsh >/dev/null 2>&1; then
  cat >&2 <<'EOF'
错误：未能自动安装 dsh，请在终端手动运行：
    npm install -g @deepseek-ai/dsh
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

# 3. 若启动命令中携带了 MONK_API_KEY，直接自动保存到受管凭据存储
if [ -n "${MONK_API_KEY:-}" ]; then
  echo "-> 自动写入预设的 MONK_API_KEY 凭据..."
  mkdir -p "$DSH_HOME"
  cat > "$DSH_HOME/.credentials.yaml" <<EOF
MONK_API_KEY: "$MONK_API_KEY"
EOF
fi

# 4. 运行安装与重绑定
echo "-> 安装并配置 Monk Profile..."
(cd "$MONK_DIR" && bash scripts/install-into-dsh.sh)

# 5. 设置终端快捷命令 'monk'
SHELL_RC=""
if [ -f "$HOME/.zshrc" ]; then
  SHELL_RC="$HOME/.zshrc"
elif [ -f "$HOME/.bashrc" ]; then
  SHELL_RC="$HOME/.bashrc"
fi

if [ -n "$SHELL_RC" ]; then
  if ! grep -q "alias monk=" "$SHELL_RC" 2>/dev/null; then
    echo "alias monk='dsh --profile monk'" >> "$SHELL_RC"
    echo "-> 已为您的终端添加快捷启动命令: monk"
  fi
fi

echo
echo "=================================================="
echo "   🎉 Monk Harness 安装成功！                     "
echo "=================================================="
echo "后续启动方式（任选一种）："
echo "  1. 终端输入: monk"
echo "  2. 终端输入: dsh --profile monk"
echo "=================================================="
