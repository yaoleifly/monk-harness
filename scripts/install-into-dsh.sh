#!/usr/bin/env bash
# 把 monk-harness 挂进 dsh 的 monk profile。
#
# 幂等：重复执行只会重建 profile 目录里的两个模板文件，不会重复安装插件
# （pnpm add 对已安装的包是空操作）。
#
# 用法：
#   ./scripts/install-into-dsh.sh              # 用 $DSH_HOME 或默认 ~/.dsh
#   DSH_HOME=/opt/dsh ./scripts/install-into-dsh.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/monk"
PROFILE_TEMPLATE="$REPO_ROOT/packages/monk-bundle/profile"

echo "==> repo     : $REPO_ROOT"
echo "==> DSH_HOME : $DSH_HOME"
echo "==> profile  : $PROFILE_DIR"

# ── 1. 依赖检查 ────────────────────────────────────────────────────────────────
if ! command -v dsh >/dev/null 2>&1; then
  cat >&2 <<'EOF'
错误：找不到 `dsh` 命令。

先安装 DeepSeek Harness：
    npx @deepseek-ai/dsh web

或者从源码构建后把 CLI 加进 PATH：
    git clone https://github.com/deepseek-ai/deepseek-harness.git
    cd deepseek-harness && pnpm install && pnpm run build
EOF
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "错误：找不到 pnpm。dsh plugin 是 pnpm 的薄转发器，需要它来装插件。" >&2
  exit 1
fi

# ── 2. 建立 profile 目录 ───────────────────────────────────────────────────────
# dsh 会在首次 `--profile monk` 时按模板初始化 profile，但模板来自 dsh 自己的
# 发行版。我们这里**主动**写入 monk 的模板，让它指向 @monk/monk-bundle。
mkdir -p "$PROFILE_DIR"
cp "$PROFILE_TEMPLATE/package.json" "$PROFILE_DIR/package.json"
# 用户 patch 层只在缺失时写入，绝不覆盖用户已经改过的内容。
if [ ! -f "$PROFILE_DIR/cordis.patch.yml" ]; then
  cp "$PROFILE_TEMPLATE/cordis.patch.yml" "$PROFILE_DIR/cordis.patch.yml"
  echo "==> 已写入用户 patch 模板（可自由编辑，保存即热重载）"
else
  echo "==> 保留已存在的用户 patch 层（未覆盖）"
fi

# ── 3. 构建 ────────────────────────────────────────────────────────────────────
echo "==> 构建 monk-harness"
(cd "$REPO_ROOT" && pnpm install --silent && pnpm build)

# ── 4. 装插件 ──────────────────────────────────────────────────────────────────
# dsh plugin 把剩余参数转发给 profile 目录里的 pnpm，然后**按已安装状态**
# 回填 dsh.profile.bundles：凡是解析到声明了 dsh.bundle 的依赖，就加入层栈。
echo "==> 挂载插件到 monk profile"
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

# ── 5. 自检 ────────────────────────────────────────────────────────────────────
echo "==> 确认 dshmarket / modsearch / dsh-context 插件已挂载"
dsh --profile monk --dump-config | grep -q "name: dshmarket" || {
  echo "警告：dshmarket 行缺失，插件市场可能未正确加载。" >&2
}
dsh --profile monk --dump-config | grep -q "name: '@liustack/modsearch'" || {
  echo "警告：@liustack/modsearch 行缺失，网页搜索可能未正确加载。" >&2
}
dsh --profile monk --dump-config | grep -q "name: dsh-context" || {
  echo "警告：dsh-context 行缺失，上下文看板可能未正确加载。" >&2
}

echo "==> 确认界面品牌已替换官方行"
dsh --profile monk --dump-config | grep -A2 "ui-brand-official" | grep -q "disabled: true" || {
  echo "警告：ui-brand-official 未被禁用，品牌槽位会与官方行争抢。" >&2
  exit 1
}

echo "==> 确认密钥卡片已挂载，且它的浏览器半边可被解析"
dsh --profile monk --dump-config | grep -q "id: monk-llm-ui" || {
  echo "警告：monk-llm-ui 行缺失，Models 页里不会有密钥输入框。" >&2
  exit 1
}
# 加载器条目只负责让包进图；浏览器半边还要能被模块系统解析到，所以两个条件
# 分开查——只查前者的话，exports 写错时会在浏览器里静默少一个输入框。
MONK_PROFILE_DIR="$PROFILE_DIR" node -e '
  const { createRequire } = require("node:module");
  const dir = process.env.MONK_PROFILE_DIR;
  const resolveFrom = createRequire(`${dir}/package.json`);
  const manifest = resolveFrom("@monk/monk-llm-ui/package.json");
  if (manifest.dsh?.client?.platform !== "web") {
    throw new Error("monk-llm-ui 未声明 web 客户端半边");
  }
  console.log(`    ${manifest.name} -> ${resolveFrom.resolve("@monk/monk-llm-ui/client")}`);
' || {
  echo "警告：monk-llm-ui 的客户端半边解析不到，密钥输入框不会出现。" >&2
  exit 1
}

cat <<EOF

完成。

下一步：
  1. 启动
       dsh --profile monk
  2. 配密钥（任选一种，都在同一个凭据 seam 上）
       打开「设置 → 模型」，Monk 那张卡片里直接粘贴密钥并保存
       或 export MONK_API_KEY="sk-..."
     界面卡片是**只写**的：密钥存进受管凭据存储，不回显、不落进 settings.yaml。

自定义：编辑 $PROFILE_DIR/cordis.patch.yml，保存即热重载。
EOF
