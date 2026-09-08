# GHCP 账号池网关 —— Docker 部署手册

面向在自己的服务器上用 Docker Compose 部署这套网关的工程师。

本手册只讲 Docker 层：怎么配置、怎么起、怎么验证、怎么运维。
服务器怎么来、防火墙怎么配、域名在哪解析，按贵方既有规范处理即可。

---

## 1. 这套系统做什么

把若干个 GitHub Copilot 账号组成一个池，对外只暴露一个统一的 API 端点。
使用方拿一把 key 就能用，请求由系统自动分摊到池中各账号；某个账号被限流会自动跳过，请求不中断。

```
使用方（Claude Code / 自研应用）
  │  虚拟 key（sk-xxx）
  ▼
Caddy ─────────── 80 / 443，唯一对外入口，自动 TLS
  ├─ api.<域名>     → LiteLLM
  └─ console.<域名> → Console
  ▼
LiteLLM ────────── 认证、身份解析、限流与计费
  + PostgreSQL（key 与消费记录）
  + Redis（多实例限流协调）
  ▼
GHCP Proxy ─────── 账号池调度：身份 → 池 → 选成员 → 该成员的凭据
  ├─ SSO
  └─ Login
  ▼
api.githubcopilot.com
```

### 安全模型

标准的两层网关结构，职责分离：

| 层 | 负责 | 说明 |
|---|---|---|
| **LiteLLM**（对外） | 认证、配额 | 使用方持虚拟 key 访问。身份由服务端从 key 的元数据解析后注入下游，使用方无法自行指定身份 |
| **Proxy**（内部） | 账号池调度 | 接受来自 LiteLLM 的身份声明。这是内部服务的常规做法——如同应用服务器信任其前置网关 |

对应到部署上，默认配置已经做好了收敛：

- 对外只有 Caddy 的 **80 / 443**
- 其余服务端口（3000 / 4000 / 7001 / 7003 / 7004）**默认绑定 `127.0.0.1`**，只有服务器本机可访问，用于跑管理脚本和健康检查
- 容器之间走 Docker 内部网络，按服务名互访，不经过端口映射

也就是说，**开箱即是收敛状态**。防火墙规则是第二道防线，而不是唯一一道。

---

## 2. 前置条件

| 项 | 要求 |
|---|---|
| 操作系统 | 任何能跑 Docker 的 Linux |
| Docker | Engine ≥ 24，含 Compose v2（`docker compose version` 能输出） |
| CPU / 内存 | 2 核 4 GB 起步；池内账号多、并发高时按需增加 |
| 磁盘 | 40 GB（镜像约 3 GB，其余为数据与日志） |
| 对外端口 | 80、443 |
| 出网 | 需能访问 `api.githubcopilot.com`、`api.github.com`；构建镜像时还需 Docker Hub、`ghcr.io`、`registry.npmjs.org` |
| 域名 | 一个解析到本机的域名，用于 Caddy 自动签发证书 |
| Copilot 账号 | 至少 2 个可用的 OAuth token（`gho_...`）。1 个也能跑，但池化没有意义 |

> **关于域名**：Caddy 会用 Let's Encrypt 自动签发并续期证书，需要 80 / 443 能被 Let's Encrypt 访问到。
> 若为内网环境，见 §9「内网部署」。

---

## 3. 配置

```bash
cd <仓库目录>
cp .env.example .env
```

按下表填写 `.env`。所有密钥用随机生成，不要手写：

```bash
# 生成一个随机密钥
openssl rand -base64 32 | tr -d '/+=' | cut -c1-43
```

| 变量 | 说明 |
|---|---|
| `PUBLIC_HOST` | 对外域名基名。最终地址为 `api.<它>` 和 `console.<它>` |
| `API_KEY` | Proxy 的入站密钥，供 LiteLLM 调用。不下发给使用方 |
| `INTERNAL_API_TOKEN` | 服务间调用令牌 |
| `SESSION_SECRET` | Console 会话签名密钥 |
| `LITELLM_MASTER_KEY` | LiteLLM 管理密钥，用于签发虚拟 key、查消费。以 `sk-` 开头 |
| `LITELLM_DB_PASSWORD` | LiteLLM 的 PostgreSQL 密码 |
| `LITELLM_UI_USERNAME` / `LITELLM_UI_PASSWORD` | 管理后台登录凭据。不设则回落为 `admin` + master key |

`.env` 里 SSO / SCIM 相关的几项在「导入已有 token」模式下仅用于让容器正常启动，
保持 `.env.example` 中的占位值即可。

生成 SSO 所需的自签证书：

```bash
bash scripts/gen-certs.sh
```

> 这一步不能跳过。缺少证书会导致 SSO 容器反复重启，进而 Proxy 起不来。

---

## 4. 启动

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.litellm.yml \
  -f deploy/docker-compose.caddy.yml \
  up -d --build
```

首次构建约 15–25 分钟。完成后应有 8 个容器：

```bash
docker compose ps
```

| 容器 | 作用 |
|---|---|
| `caddy` | 对外入口，TLS |
| `litellm` | 认证与限流网关 |
| `litellm-db` | LiteLLM 的 PostgreSQL |
| `litellm-redis` | 限流协调 |
| `proxy` | 账号池调度 |
| `sso` / `login` | 账号接入所需的支撑服务 |
| `console` | 运维控制台 |

---

## 5. 验证

```bash
bash scripts/validate-health.sh
```

五项全绿即可：

```
════════ 服务健康检查 ════════
  ✅ proxy      200
  ✅ sso        200
  ✅ login      200
  ✅ console    200
  ✅ litellm    200
```

再确认 TLS 已签发：

```bash
curl -sI https://api.<域名>/health/liveliness | head -1
```

---

## 6. 接入账号并建池

准备一个账号清单文件，每行 `账号名,gho_token`：

```
acme-01,gho_xxxxxxxxxxxxxxxxxxxx
acme-02,gho_yyyyyyyyyyyyyyyyyyyy
```

一条命令完成建用户、导入凭据、建池、加成员：

```bash
./deploy/provision.sh team-pool accounts.txt
```

输出会逐段显示各阶段结果，最后打印池状态：

```
════════ 6. 池状态 ════════
  池名     : team-pool
  策略     : least-loaded
  可用     : 2/2
    acme-01   active   最近使用 从未
    acme-02   active   最近使用 从未
```

### 分配策略

| 策略 | 行为 | 何时用 |
|---|---|---|
| `least-loaded`（默认） | 每次挑最久未使用的账号 | 多人共用一个池，负载最均匀 |
| `sticky-affinity` | 同一会话固定同一账号 | 需按会话审计追溯，或使用方用了有状态接口 |
| `round-robin` | 按会话哈希分配 | 同一会话结果稳定但不看负载 |

> prompt 缓存由客户端的 `cache_control` 标记驱动，网关侧不需要配置。
> Claude Code 自带该字段；自研客户端需要自己加。

---

## 7. 发放给使用方

```bash
./deploy/create-key.sh <租户名> team-pool 100 60 200000
#                       租户  池名  预算$ rpm  tpm
```

输出的 `sk-...` 就是交给使用方的凭据，**只显示一次**。

使用方调用方式：

```bash
curl -X POST https://api.<域名>/v1/messages \
  -H "x-api-key: sk-xxxxx" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-opus-5","max_tokens":1024,
       "messages":[{"role":"user","content":"你好"}]}'
```

每把 key 的预算、rpm、tpm、并发上限各自独立，互不影响。

---

## 8. 日常运维

### 控制台

浏览器打开 `https://console.<域名>`，可查看与操作：
账号列表与状态、账号池成员增删、请求统计（含每条请求实际落在哪个账号）、错误诊断。

LiteLLM 管理后台在 `https://api.<域名>/ui/`，用 `.env` 里设置的
`LITELLM_UI_USERNAME` / `LITELLM_UI_PASSWORD` 登录，可查看各 key 的消费与调用明细。

### 常用命令

```bash
# 看状态
docker compose ps

# 看日志
docker compose logs proxy --tail 100 -f

# 加账号（热操作，无需重启）
./deploy/provision.sh team-pool 新账号清单.txt

# 重启单个服务
docker compose restart proxy
```

### 备份

需要备份的是三处数据卷：

```bash
docker run --rm \
  -v ghcp-pool_proxy-data:/data:ro \
  -v "$PWD":/backup alpine \
  tar czf /backup/proxy-data-$(date +%F).tar.gz -C /data .

docker compose exec -T litellm-db \
  pg_dump -U litellm litellm | gzip > litellm-$(date +%F).sql.gz
```

`caddy-data` 卷存的是已签发证书，一并备份可避免重建时重新申请。

### 升级

```bash
git pull
docker compose -f docker-compose.yml -f docker-compose.litellm.yml \
  -f deploy/docker-compose.caddy.yml up -d --build
```

数据库迁移在容器启动时自动执行。

---

## 9. 内网部署

若服务器不能被 Let's Encrypt 访问，Caddy 无法自动签发证书。两种处理方式：

**A. 使用 Caddy 内置 CA 签发内部证书**

在 `deploy/Caddyfile.pool` 顶部的全局配置块中加入 `local_certs`，
各站点块中加入 `tls internal`。使用方需信任 Caddy 生成的根证书
（位于 `caddy-data` 卷的 `caddy/pki/authorities/local/root.crt`）。

**B. 挂载贵方自有证书**

在 `deploy/docker-compose.caddy.yml` 中挂载证书目录，
并在站点块中写 `tls /path/to/cert.pem /path/to/key.pem`。

若容器需经代理出网，在 `.env` 中设置 `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`
并在 compose 的 `environment` 中透传给 `proxy`、`login`、`sso` 三个服务。

---

## 10. 排障

| 现象 | 常见原因 | 处理 |
|---|---|---|
| SSO 容器反复重启 | 缺自签证书 | 跑 `bash scripts/gen-certs.sh` 后重启 |
| Proxy 起不来 | 依赖的 SSO 未就绪 | 先看 `docker compose logs sso` |
| 导入账号提示找不到用户 | 未先创建 SSO 用户 | 用 `provision.sh` 而非手工调接口 |
| 调用返回 401 | key 缺失或错误 | 检查 `x-api-key` |
| 调用返回 403 | 用了 master key 发推理请求 | master key 仅用于管理，推理须用虚拟 key |
| TLS 证书签发失败 | 80/443 不可达或域名未解析 | 检查解析与端口；内网见 §9 |
| 域名打不开但容器都健康 | 网络层未放行 80/443 | 按贵方规范检查防火墙/安全组 |

诊断命令：

```bash
docker compose ps                      # 容器状态
docker compose logs <服务> --tail 100  # 服务日志
bash scripts/validate-health.sh        # 五项健康检查
```

---

## 附：端口一览

| 端口 | 服务 | 绑定 |
|---|---|---|
| 80 / 443 | Caddy | 对外 |
| 3000 | Proxy | `127.0.0.1` |
| 4000 | LiteLLM | `127.0.0.1` |
| 7001 / 7003 / 7004 | SSO / Login / Console | `127.0.0.1` |

绑定地址由 `.env` 的 `BIND_ADDR` 控制，默认 `127.0.0.1`，通常无需修改。
