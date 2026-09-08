#!/usr/bin/env bash
#
# 账号池初始化：建 SSO 用户 → 导入 Copilot token → 建池 → 加成员 → 打印状态
#
# 用法（在 VM 上 /opt/ghcp-pool 目录执行）：
#   ./deploy/provision.sh <池名> <账号清单文件>
#
# 账号清单文件格式：每行 `账号名,gho_token`，例如
#   alice,gho_xxxxxxxxxxxxxxxxxxxx
#   bob,gho_yyyyyyyyyyyyyyyyyyyy
#
# 注意：
#   - 账号名会被系统转成小写
#   - SSO 用户必须先存在，本脚本会自动创建
#   - 导入接口需要同时带 X-Internal-Token 和 x-api-key 两个头
#
set -euo pipefail

POOL="${1:?用法: ./deploy/provision.sh <池名> <账号清单文件>}"
LIST="${2:?用法: ./deploy/provision.sh <池名> <账号清单文件>}"
[ -f "$LIST" ] || { echo "找不到账号清单文件: $LIST" >&2; exit 1; }

cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

PROXY="http://127.0.0.1:3000"
SSO="http://127.0.0.1:7001"
# 管理类接口只要内部令牌；导入接口还要 Proxy 的入站密钥
H_INT=(-H "X-Internal-Token: ${INTERNAL_API_TOKEN}" -H "Content-Type: application/json")
H_BOTH=("${H_INT[@]}" -H "x-api-key: ${API_KEY}")

# 生成 SSO 用户的初始密码（导入模式下不会真正用到，但接口要求非空）
SSO_PASSWORD="$(node -e "console.log(require('crypto').randomBytes(12).toString('base64url'))" 2>/dev/null \
  || openssl rand -base64 16 | tr -d '/+=')"

echo "════════ 1. 创建 SSO 用户 ════════"
while IFS=, read -r name token; do
  name="$(echo "$name" | tr -d ' \r' | tr '[:upper:]' '[:lower:]')"
  [ -z "$name" ] && continue
  code=$(curl -s -o /tmp/sso_out -w '%{http_code}' -X POST "${SSO}/api/users" \
    "${H_INT[@]}" -d "{\"ssoUser\":\"${name}\",\"password\":\"${SSO_PASSWORD}\"}")
  case "$code" in
    200|201) echo "  ✓ ${name}" ;;
    # 已存在是正常情况（重复执行本脚本时必然发生）。
    # SSO 对此返回 400 + already exists，不是 409，所以要看消息体判断。
    409)     echo "  = ${name}（已存在）" ;;
    400)
      if grep -qi "already exists" /tmp/sso_out; then
        echo "  = ${name}（已存在）"
      else
        echo "  ✗ ${name}  HTTP ${code}  $(head -c 160 /tmp/sso_out)"
      fi
      ;;
    *)       echo "  ✗ ${name}  HTTP ${code}  $(head -c 160 /tmp/sso_out)" ;;
  esac
done < "$LIST"

echo
echo "════════ 2. 导入 Copilot token ════════"
# CSV 表头必须精确为 name,copilotOauthToken
{
  echo "name,copilotOauthToken"
  while IFS=, read -r name token; do
    name="$(echo "$name" | tr -d ' \r' | tr '[:upper:]' '[:lower:]')"
    token="$(echo "$token" | tr -d ' \r')"
    [ -z "$name" ] || [ -z "$token" ] && continue
    echo "${name},${token}"
  done < "$LIST"
} > /tmp/import.csv

python3 - <<'PY' > /tmp/import.json
import json, io
csv = io.open('/tmp/import.csv', encoding='utf-8').read()
io.open('/tmp/import.json', 'w', encoding='utf-8').write(json.dumps({'csvText': csv}))
PY

curl -s -X POST "${PROXY}/api/accounts/copilot-oauth-token/import" "${H_BOTH[@]}" -d @/tmp/import.json \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
s = d.get('summary', {})
print('  总计 %s  成功 %s  失败 %s' % (s.get('total'), s.get('success'), s.get('failed')))
for r in d.get('rows', []):
    if r.get('status') != 'success':
        print('  ✗ %s: %s' % (r.get('name'), str(r.get('detail'))[:140]))
"
rm -f /tmp/import.csv /tmp/import.json /tmp/sso_out

echo
echo "════════ 3. 账号状态 ════════"
curl -s "${PROXY}/api/accounts?pageSize=100" "${H_INT[@]}" | python3 -c "
import sys, json
for a in json.load(sys.stdin).get('items', []):
    print('  %-20s %s' % (a['identity'], a['copilotOauthStatus']))
"

echo
echo "════════ 4. 创建账号池 ════════"
curl -s -X POST "${PROXY}/api/pools" "${H_INT[@]}" \
  -d "{\"poolId\":\"${POOL}\",\"strategy\":\"least-loaded\",\"sessionTtlSeconds\":1800,\"cooldownSeconds\":300,\"failureThreshold\":3}" \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
if 'error' in d: print('  ✗', json.dumps(d['error'], ensure_ascii=False)[:180])
else: print('  ✓ %s  策略=%s' % (d['poolId'], d['strategy']))
"

echo
echo "════════ 5. 加入池成员 ════════"
while IFS=, read -r name token; do
  name="$(echo "$name" | tr -d ' \r' | tr '[:upper:]' '[:lower:]')"
  [ -z "$name" ] && continue
  curl -s -X POST "${PROXY}/api/pools/${POOL}/members" "${H_INT[@]}" -d "{\"identity\":\"${name}\"}" \
    | python3 -c "
import sys, json
d = json.load(sys.stdin)
if 'error' in d: print('  ✗ $name: %s' % json.dumps(d['error'], ensure_ascii=False)[:140])
else: print('  + %s [%s] 权重=%s' % (d['identity'], d['state'], d.get('weight')))
"
done < "$LIST"

echo
echo "════════ 6. 池状态 ════════"
curl -s "${PROXY}/api/pools/${POOL}" "${H_INT[@]}" | python3 -c "
import sys, json
p = json.load(sys.stdin)
print('  池名     :', p['poolId'])
print('  策略     :', p['strategy'])
print('  会话TTL  :', p['sessionTtlSeconds'], '秒')
print('  冷却     :', p['cooldownSeconds'], '秒')
print('  失败阈值 :', p['failureThreshold'])
print('  可用     : %s/%s' % (p['activeMembers'], p['totalMembers']))
for m in p['members']:
    print('    %-20s %-10s 最近使用 %s' % (m['identity'], m['state'], m.get('lastUsedAt') or '从未'))
"

echo
echo "完成。下一步：创建 LiteLLM 虚拟 key，把 metadata.trusted_user_id 设为 \"${POOL}\"。"
