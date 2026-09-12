#!/usr/bin/env bash
#
# monk-harness 端到端冒烟测试。
#
# 为什么需要独立的 DSH_HOME：`agent-default-model` 属于可运行时改写的设置区，
# 而设置区**优先于** profile 的补丁层。因此只要用户自己的 ~/.dsh/settings.yaml
# 里已经选了一个模型，组合包里的 monk-official 默认值就会被静默盖掉——本脚本
# 打不到自己的路由，却会以为测过了。用一个干净的 home 让配置回到"没有设置区"
# 的状态，monk-official 才会作为兜底默认值生效。
#
# 用法：bash scripts/e2e-smoke.sh [端口]
set -euo pipefail

PORT="${1:-7788}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_DIR="${MONK_E2E_HOME:-/tmp/monk-e2e-home}"
LOG=/tmp/monk-mock-requests.jsonl
NODE_BIN="${NODE_BIN:-/Users/go/.workbuddy-ai/binaries/node/versions/22.22.2/bin/node}"
DSH_BIN="${DSH_BIN:-$(command -v dsh)}"

cleanup() {
  [[ -n "${MOCK_PID:-}" ]] && kill "$MOCK_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "== 1. 启动本地 mock Monk 服务端 (:$PORT) =="
"$NODE_BIN" "$REPO/scripts/mock-monk-server.mjs" "$PORT" &
MOCK_PID=$!
for _ in $(seq 1 40); do
  curl -s --noproxy '*' -o /dev/null "http://127.0.0.1:$PORT/v1/models" 2>/dev/null && break
  sleep 0.1
done

echo "== 2. 搭建干净的 DSH_HOME: $HOME_DIR =="
rm -rf "$HOME_DIR"
mkdir -p "$HOME_DIR/profiles/monk-headless/node_modules/@monk"
ln -sfn "$HOME_DIR/profiles/node_modules" "$HOME_DIR/profiles/node_modules.tmp" 2>/dev/null || true
rm -f "$HOME_DIR/profiles/node_modules.tmp"
mkdir -p "$HOME_DIR/profiles/node_modules"
ln -sfn "$HOME/.dsh/profiles/node_modules/@deepseek-ai" \
        "$HOME_DIR/profiles/node_modules/@deepseek-ai"

cat > "$HOME_DIR/profiles/monk-headless/package.json" <<'JSON'
{
  "name": "dsh-profile-monk-headless",
  "private": true,
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-headless",
        "@monk/monk-bundle"
      ],
      "patchReload": "startup"
    }
  }
}
JSON
printf '# 用户层：空数组，不要写成组合包 patch 的副本。\n[]\n' \
  > "$HOME_DIR/profiles/monk-headless/cordis.patch.yml"
for p in monk-llm monk-llm-ui monk-router monk-usage monk-ui-brand monk-bundle; do
  ln -sfn "$REPO/packages/$p" "$HOME_DIR/profiles/monk-headless/node_modules/@monk/$p"
done

echo "== 3. 确认默认模型回落到 monk-official（而不是设置区里的其它提供方） =="
DSH_HOME="$HOME_DIR" "$DSH_BIN" --profile monk-headless --dump-config \
  | grep -A4 '^\- id: agent-default-model'

echo "== 4. 跑一次完整 agent 回合 =="
: > "$LOG"
set +e
DSH_HOME="$HOME_DIR" \
MONK_API_KEY=sk-mock-key \
MONK_BASE_URL="http://127.0.0.1:$PORT/v1" \
  "$DSH_BIN" --profile monk-headless "用一句话说明你运行在什么模型上"
STATUS=$?
set -e

echo
echo "== 5. mock 服务端收到的请求 =="
if [[ -s "$LOG" ]]; then
  "$NODE_BIN" -e '
    const { readFileSync } = require("node:fs");
    const lines = readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean);
    console.log(`共 ${lines.length} 次请求`);
    lines.forEach((l, i) => {
      const r = JSON.parse(l);
      console.log(`\n--- 请求 ${i + 1}  ${r.method} ${r.url}`);
      console.log(`    authorization : ${r.authorization}`);
      console.log(`    model         : ${r.body.model}`);
      console.log(`    stream        : ${r.body.stream}`);
      console.log(`    stream_options: ${JSON.stringify(r.body.stream_options)}`);
      console.log(`    messages      : ${r.body.messages?.length ?? 0} 条`);
      console.log(`    tools         : ${(r.body.tools ?? []).map(t => t.function?.name).join(", ") || "(无)"}`);
      const sys = (r.body.messages ?? []).find(m => m.role === "system");
      if (sys) console.log(`    system 首行   : ${String(sys.content).split("\n")[0]}`);
    });
  ' "$LOG"
else
  echo "（mock 没有收到任何请求——说明请求没有走 monk-official 路由）"
fi

echo
echo "== 退出码: $STATUS =="
exit "$STATUS"
