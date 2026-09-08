# GHCP 账号池网关

把 GitHub Copilot 订阅转成 Claude / GPT 的 API 服务，并支持**一个 key 背后挂多个 Copilot 账号**。

在开源项目 [ghcp-api-console](https://github.com/enjoyopenfuture/ghcp-api-console) 基础上改造：新增账号池、会话分配策略、故障转移，并叠加 LiteLLM 做多租户隔离。

---

## 解决什么问题

| 问题 | 怎么解决 |
|---|---|
| 单个 Copilot 账号额度不够 | 多账号组池，额度累加 |
| 单个账号并发/限流撑不住 | 按负载分摊到池内多个账号 |
| 账号被限流导致服务中断 | 自动冷却 + 切换到其他成员，请求不中断 |
| 多个租户共用，需要隔离与计费 | LiteLLM 虚拟 key，身份不可伪造，per-key 限流与记账 |

---

## 架构

```
客户端（Claude Code / 自研应用）
  │  Authorization: Bearer sk-xxx   ← LiteLLM 虚拟 key，一租户一把
  ▼
Caddy :443                自动 TLS + 按域名分流
  ├─ api.<host>      → LiteLLM :4000
  └─ console.<host>  → Console  :7004
  ▼
LiteLLM :4000             虚拟 key、身份注入、per-key 限流与计费
  ├─ PostgreSQL           虚拟 key 与消费记录
  └─ Redis                协调与响应缓存
  │  强制注入 X-User-Identity = 该 key 的 metadata.trusted_user_id
  ▼
GHCP Proxy :3000          ★ 账号池在这一层
  │    identity → 是池？→ 按策略选成员 → 用该成员的 Copilot OAuth token
  ├─ SSO   :7001          自建 SAML IdP + SCIM（自动开通链路）
  └─ Login :7003          Device Flow + 无头浏览器授权
  ▼
api.githubcopilot.com
```

> ⚠️ **Proxy 的 3000 端口绝不能直接暴露公网。** 它的身份来自 `X-User-Identity` 请求头，
> 客户端可任意伪造。LiteLLM 的 `trusted_identity_hook` 会剥掉该头并按虚拟 key 重写，
> 是整套多租户隔离的**唯一安全边界**。

---

## 账号池

### 三种选择策略

| 策略 | 行为 | 适用 |
|---|---|---|
| **`least-loaded`**（默认） | 每次挑最久未使用的账号 | **多租户共用一个池** |
| `sticky-affinity` | 同一会话固定同一账号 | 需按会话审计追溯；客户端用了 `/responses` 的 `previous_response_id` 等有状态接口 |
| `round-robin` | 按会话哈希分配 | 需要确定性映射但不看负载 |

### 其他机制

- **选择算法**：Rendezvous（HRW）哈希，支持权重。增删账号时只重映射受影响的那部分。
- **会话 key**：`X-Session-Id` 头 > 请求体 `metadata.user_id` > system+首条 user message 前缀哈希 > 固定兜底。
- **故障转移**：上游 429/402 立即冷却；其余错误累计到阈值才冷却；冷却期满自动恢复。
- **统计归因**：`identity` 记实际成员账号，`pool_id` 记对外池名，两者都可查。

---

## 文档

| 文档 | 内容 |
|---|---|
| [00 方案总览](docs-pool/00-方案总览.md) | 架构、组件职责、请求全流程、账号池设计 |
| [01 部署前置清单](docs-pool/01-部署前置清单.md) | **动手前发给客户**：要买什么、开什么权限、多久 |
| [02 部署操作手册](docs-pool/02-部署操作手册.md) | **从零到可用的逐步命令**，含检查清单 |
| [03 运维与排障](docs-pool/03-运维与排障.md) | 探活、故障速查表、策略破坏后的恢复 |
| [04 Console 界面操作](docs-pool/04-Console界面操作手册.md) | 每个页面怎么点，含账号池页详解 |
| [05 账号批量接入](docs-pool/05-账号批量接入.md) | 导入已有 token / 完整自动化两条路线 |
| [06 测试用例与验证](docs-pool/06-测试用例与验证.md) | 测试脚本说明与交付验收标准 |

上游项目的原始文档保留在 `docs/`。

---

## 快速开始

```bash
cp .env.example .env
# 编辑 .env，填入 PUBLIC_HOST 与各项密钥

docker compose \
  -f docker-compose.yml \
  -f docker-compose.litellm.yml \
  -f docker-compose.caddy.yml \
  up -d --build
```

完整步骤见 [部署操作手册](docs-pool/02-部署操作手册.md)。

---

## 目录

```
deploy/          VM 初始化、Caddy 配置、账号池初始化脚本
litellm/         LiteLLM 镜像、配置、身份注入 Hook
src/             源码
  proxy/src/pool/  ★ 账号池实现
tests/           测试与验证脚本
docs-pool/       本方案文档
docs/            上游原始文档
```

---

## 测试

```bash
npm --workspace @ghcp/proxy run test      # 单元 + API 测试
node tests/selector-check.cjs             # 选择算法四条性质
```

> 已知：`persists JSON, SSE, plain-text...` 这一条在**上游原始代码里就是失败的**，
> 改造前后基线一致，不是本次改造引入。详见 [06 测试用例](docs-pool/06-测试用例与验证.md)。
