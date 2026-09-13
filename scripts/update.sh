#!/usr/bin/env bash
#
# Monk Harness 一键更新脚本。
# 当 DeepSeek Harness (dsh) 升级或 monk-harness 更新时运行本脚本。
#
# 用法：
#   bash scripts/update.sh
#   DSH_HOME=/opt/dsh bash scripts/update.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/monk"

echo "=================================================="
echo "      Monk Harness 一键更新与同步助手             "
echo "=================================================="
echo "-> 项目目录 : $REPO_ROOT"
echo "-> DSH_HOME : $DSH_HOME"
echo "-> Profile  : $PROFILE_DIR"
echo

# 1. 检查 dsh 与 pnpm 环境
if ! command -v dsh >/dev/null 2>&1; then
  echo "错误：找不到 dsh 命令。请先确保 DeepSeek Harness 已全局安装或加入 PATH。" >&2
  exit 1
fi
DSH_VER="$(dsh --version 2>/dev/null || echo '未知')"
echo "-> 检测到 DeepSeek Harness 版本: $DSH_VER"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "错误：找不到 pnpm 命令。" >&2
  exit 1
fi

# 2. 重新构建 monk-harness 所有子包
echo "-> 1/4 重新构建 monk-harness..."
(cd "$REPO_ROOT" && pnpm install --silent && pnpm build)

# 3. 创建/同步 profile 模板
echo "-> 2/4 同步 profile 结构..."
mkdir -p "$PROFILE_DIR"
cp "$REPO_ROOT/packages/monk-bundle/profile/package.json" "$PROFILE_DIR/package.json"
if [ ! -f "$PROFILE_DIR/cordis.patch.yml" ]; then
  cp "$REPO_ROOT/packages/monk-bundle/profile/cordis.patch.yml" "$PROFILE_DIR/cordis.patch.yml"
fi

# 4. 重新挂载与关联插件
echo "-> 3/4 重新挂载插件到 monk profile..."
dsh plugin --profile monk add \
  "$REPO_ROOT/packages/monk-bundle" \
  "$REPO_ROOT/packages/monk-llm" \
  "$REPO_ROOT/packages/monk-llm-ui" \
  "$REPO_ROOT/packages/monk-router" \
  "$REPO_ROOT/packages/monk-usage" \
  "$REPO_ROOT/packages/monk-ui-brand" \
  dshmarket \
  @liustack/modsearch \
  dsh-context

# 5. 同步 Monk 专属 Agent Presets
echo "-> 4/5 同步 Monk 专属 Agent Presets 到 $DSH_HOME/.agent-presets..."
mkdir -p "$DSH_HOME/.agent-presets"
for p in "$REPO_ROOT/packages/monk-bundle/presets/"*; do
  if [ -d "$p" ]; then
    preset_name="$(basename "$p")"
    mkdir -p "$DSH_HOME/.agent-presets/$preset_name"
    cp "$p/preset.yml" "$DSH_HOME/.agent-presets/$preset_name/preset.yml"
    cp "$p/agent.cordis.yml" "$DSH_HOME/.agent-presets/$preset_name/agent.cordis.yml"
  fi
done

# 6. 触发热重载与自检
echo "-> 5/5 触发热重载与运行自检..."
touch "$PROFILE_DIR/cordis.patch.yml" 2>/dev/null || true

dsh --profile monk --dump-config | grep -q "id: monk-llm" || {
  echo "警告：monk-llm 未在组合配置中显出，请检查组装。" >&2
  exit 1
}

echo
echo "=================================================="
echo "   Monk Harness 更新完成！所有插件与服务已就绪。  "
echo "=================================================="
echo "后置指引："
echo "  1. 启动/重启 Web 界面:  dsh --profile monk"
echo "  2. 运行命令行系统自检:  /monk doctor"
echo
