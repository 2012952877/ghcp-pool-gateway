#!/usr/bin/env bash
#
# 创建 LiteLLM 虚拟 key —— 这是发给最终用户的凭据
#
# 用法（在 VM 上 /opt/ghcp-pool 目录执行）：
#   ./deploy/create-key.sh <租户名> <池名> [每月预算美元] [rpm] [tpm]
#
# 示例：
#   ./deploy/create-key.sh tenant-a team-pool 100 60 200000
#
# ⚠️ 关键：metadata.trusted_user_id 决定这把 key 的请求走哪个池。
#    客户端无法覆盖它 —— trusted_identity_hook 会剥掉客户端传的
#    X-User-Identity 头并按这里的值重写。这是多租户隔离的根基。
#
set -euo pipefail

ALIAS="${1:?用法: ./deploy/create-key.sh <租户名> <池名> [预算] [rpm] [tpm]}"
POOL="${2:?用法: ./deploy/create-key.sh <租户名> <池名> [预算] [rpm] [tpm]}"
BUDGET="${3:-100}"
RPM="${4:-60}"
TPM="${5:-200000}"

cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

LITELLM="http://127.0.0.1:${LITELLM_PORT:-4000}"

# 先确认池存在，避免建出一把指向不存在的池的 key
POOL_CHECK=$(curl -s -o /dev/null -w '%{http_code}' \
  "http://127.0.0.1:3000/api/pools/${POOL}" \
  -H "X-Internal-Token: ${INTERNAL_API_TOKEN}")
if [ "$POOL_CHECK" != "200" ]; then
  echo "✗ 池 \"${POOL}\" 不存在（HTTP ${POOL_CHECK}）。请先用 provision.sh 创建。" >&2
  exit 1
fi

RESP=$(curl -s -X POST "${LITELLM}/key/generate" \
  -H "Authorization: Bearer ${LITELLM_MASTER_KEY}" \
  -H "Content-Type: application/json" \
  -d "{
    \"key_alias\": \"${ALIAS}\",
    \"models\": [],
    \"metadata\": {\"trusted_user_id\": \"${POOL}\"},
    \"max_budget\": ${BUDGET},
    \"budget_duration\": \"30d\",
    \"rpm_limit\": ${RPM},
    \"tpm_limit\": ${TPM},
    \"max_parallel_requests\": 5,
    \"duration\": \"90d\"
  }")

echo "$RESP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
if 'error' in d or not d.get('key'):
    print('✗ 创建失败:', json.dumps(d, ensure_ascii=False)[:400]); sys.exit(1)
print('════════════════════════════════════════════════')
print('  租户       :', d.get('key_alias'))
print('  目标池     :', (d.get('metadata') or {}).get('trusted_user_id'))
print('  每月预算   : \$%s' % d.get('max_budget'))
print('  RPM / TPM  : %s / %s' % (d.get('rpm_limit'), d.get('tpm_limit')))
print('  并发上限   :', d.get('max_parallel_requests'))
print('  过期时间   :', d.get('expires'))
print('════════════════════════════════════════════════')
print()
print('  发给用户的 key（只显示这一次，请立即保存）：')
print()
print('   ', d['key'])
print()
"

echo "  客户端调用示例："
echo
echo "    curl -X POST https://api.\${PUBLIC_HOST}/v1/messages \\"
echo "      -H \"x-api-key: <上面那把key>\" \\"
echo "      -H \"anthropic-version: 2023-06-01\" \\"
echo "      -H \"Content-Type: application/json\" \\"
echo "      -d '{\"model\":\"claude-opus-5\",\"max_tokens\":1024,\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}]}'"
echo
