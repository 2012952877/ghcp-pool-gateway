#!/usr/bin/env bash
#
# 全栈健康检查。逐项报告，不会在第一个失败就退出。
#
# 用法：
#   bash scripts/validate-health.sh
#
# 可用环境变量覆盖默认地址（默认都是宿主机上的 localhost）：
#   PROXY_URL SSO_URL LOGIN_URL CONSOLE_URL LITELLM_URL
#
set -uo pipefail   # 故意不用 -e：要让所有检查都跑完

proxy="${PROXY_URL:-http://localhost:3000}"
sso="${SSO_URL:-http://localhost:7001}"
login="${LOGIN_URL:-http://localhost:7003}"
console="${CONSOLE_URL:-http://localhost:7004}"
litellm="${LITELLM_URL:-http://localhost:4000}"

fail=0

check() {
  local name="$1" url="$2"
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$url" 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then
    printf '  ✅ %-10s %s\n' "$name" "$code"
  else
    printf '  ❌ %-10s %s   %s\n' "$name" "$code" "$url"
    fail=$((fail + 1))
  fi
}

echo "════════ 服务健康检查 ════════"
check proxy    "${proxy}/readyz"
check sso      "${sso}/healthz"
check login    "${login}/healthz"
check console  "${console}/healthz"
check litellm  "${litellm}/health/liveliness"

echo
if [ "$fail" -eq 0 ]; then
  echo "  全部通过。"
else
  echo "  ${fail} 项失败。排查建议："
  echo "    1) docker compose ps                    看容器是否 running/healthy"
  echo "    2) docker compose logs <服务名> --tail 50"
  echo "    3) 若全部 000：检查 NSG（网卡层 + 子网层都要放行）"
  echo "    4) proxy 起不来 → 先看 sso（缺 /certs/idp-cert.pem 会 CrashLoop）"
fi
exit "$fail"
