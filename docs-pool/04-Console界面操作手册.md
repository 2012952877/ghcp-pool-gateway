# Console 界面操作手册

> 本文档只讲**界面上怎么点**。部署、域名、证书、LiteLLM 虚拟 key 的内容在同目录其他文档里。
> 读者假定：已经拿到 Console 地址，第一次打开这个界面。

## 目录

0. [本文档的验证状态](#0-本文档的验证状态先看这个)
1. [先搞清楚这个界面能管什么、不能管什么](#1-先搞清楚这个界面能管什么不能管什么)
2. [首次进入：Initialize Console 是「创建管理员」，不是「登录」](#2-首次进入initialize-console-是创建管理员不是登录)
3. [全局布局与导航](#3-全局布局与导航)
4. [逐页说明](#4-逐页说明)
5. [Account Pools 页详解](#5-account-pools-页详解本次新增)
6. [三个高频任务的完整点击路径](#6-三个高频任务的完整点击路径)
7. [风险操作清单：点之前必须确认什么](#7-风险操作清单点之前必须确认什么)
8. [界面上做不到、必须走命令行的事](#8-界面上做不到必须走命令行的事)
9. [报错速查表](#9-报错速查表)

---

## 0. 本文档的验证状态（先看这个）

| 内容 | 状态 |
|---|---|
| 页面元素、按钮文案、确认框文案、toast 文案、默认值、校验规则 | **逐行核对源码**得出（`src/console/src/web/App.tsx`、`src/console/src/web/PoolsPage.tsx`、`src/console/src/server/*`、`src/proxy/src/pool/*`、`src/proxy/src/routes/poolApi.ts`、`src/proxy/src/routes/compatible.ts`、`src/proxy/src/db/sqliteStorage.ts`、`src/proxy/src/accounts/copilotOauthTokenImport.ts`、`src/sso/src/users/service.ts`） |
| 云上端到端链路（虚拟 key → 池 → 成员轮流承接、缓存跨账号命中） | **已实测** |
| 账号导入 / 建池 / 加成员 | 实际部署时是走 API 做的（`provision.sh`）。本文给出的 **UI 等价路径未逐个点过**，第一次操作请按每一步的「期望看到」逐条核对 |
| 标注「源码判读，未实测」的条目 | 是读代码推出来的结论，行为方向可信，但没在云上复现过 |
| 标注「未验证」「需现场确认」的条目 | 就是真的没试过，不要当成结论 |

**两条使用前提，先说清楚：**

1. **仓库路径**：本文按整理后的结构写（`deploy/provision.sh`、`tests/…`）。当前工作副本里这些脚本还散在**仓库根目录**（`provision.sh`、`selector-check.cjs`、`cache-final.mts` 等）。执行前先 `ls` 确认实际位置。
2. **界面语言是混的**：左侧导航和大部分页面是英文，只有 Account Pools 页（本次新增）是中文。这不是 bug，是改造时只汉化了新页面。

---

## 1. 先搞清楚这个界面能管什么、不能管什么

Console 是 **Proxy / SSO / Login 三个内部服务的运维界面**。它通过内部令牌（请求头 `X-Internal-Token`）代理调用这三个服务的 admin API。

```
浏览器 ──https──► Caddy ──► Console:7004 ──X-Internal-Token──┬─► Proxy:3000   （账号、账号池、请求统计、错误诊断）
                                                             ├─► SSO:7001     （SSO 用户、SCIM）
                                                             └─► Login:7003   （登录任务）
```

**Console 看不到 LiteLLM。** 虚拟 key、per-key 限流、计费金额都在 LiteLLM 那一侧（PostgreSQL），Console 里没有任何一个页面显示它们。要查「某个租户花了多少钱」，看 LiteLLM，不要在这里找。

| 能做 | 不能做 |
|---|---|
| 建/删账号池、加/移成员、改策略、解除冷却 | 发/改/删 LiteLLM 虚拟 key |
| 导入 Copilot OAuth token、看账号 token 状态 | 看虚拟 key 的消费金额 |
| 查 Proxy 侧请求统计（token 数、成功/失败） | 按时间范围筛统计（没有时间选择器） |
| 下载上游失败的完整快照 | 改 Caddy / NSG / 证书 |
| 改 Console 管理员密码、SSO/Login 运行时参数 | 管理多个 Console 管理员（只支持一个） |

### 1.1 从哪里访问 Console

Console 通过 Caddy 以 HTTPS 对外提供：

```
https://console.<PUBLIC_HOST>/
```

`proxy` / `sso` / `login` / `console` 四个服务在宿主机上的端口映射默认绑定 `127.0.0.1`
（由 `.env` 的 `BIND_ADDR` 控制），只有服务器本机能连，因此不存在绕过 TLS 明文访问 Console 的路径。

网络层放行 **80 / 443**（以及你自己要用的 22）即可。

上线后可以从一台外部机器验证一次：

```bash
curl -m 5 http://<服务器地址>:7004/     # 期望：超时或拒绝
curl -sI https://console.<PUBLIC_HOST>/ # 期望：200 或 302
```

---

## 2. 首次进入：Initialize Console 是「创建管理员」，不是「登录」

### 2.1 打开地址

浏览器访问：

```
https://console.<PUBLIC_HOST>/
```

`<PUBLIC_HOST>` 取值：部署时写进 `.env.pool` 的 `PUBLIC_HOST`，形如 `20.78.139.35.nip.io`（VM 公网 IP + `.nip.io`），或客户自有域名。可以在 VM 上 `grep PUBLIC_HOST /opt/ghcp-pool/.env` 确认（部署目录实测为 `/opt/ghcp-pool`，`.env.pool` 在 VM 上落地为 `.env`）。

> **中国区注意**：如果用了代理软件，域名会被解析成假 IP（Fake-IP，如 `6.6.4.243`）。**这是正常的、也是必需的**，流量要走隧道。**不要改 hosts 文件**强行解析到真实 IP，那样反而连不上。浏览器打不开时，先怀疑 NSG 被订阅策略清空了，而不是 DNS。

### 2.2 你会看到两种界面之一

```
┌────────────────────────────────────────────────────────────────┐
│  GHCP Production Console                                       │
│  Accounts, SSO users, AI Credits usage, request stats, ...     │
│                                                                │
│              ┌──────────────────────────────────┐              │
│              │  Initialize Console              │  ← 关键在这行 │
│              │  Sign in before accessing ...    │              │
│              │                                  │              │
│              │  ┌────────────────────────────┐  │              │
│              │  │ admin                      │  │ ← 已预填     │
│              │  └────────────────────────────┘  │              │
│              │  ┌────────────────────────────┐  │              │
│              │  │ Password                   │  │ ← 空的       │
│              │  └────────────────────────────┘  │              │
│              │        ┌──────────────┐          │              │
│              │        │ Create admin │          │ ← 按钮文案    │
│              │        └──────────────┘          │              │
│              └──────────────────────────────────┘              │
└────────────────────────────────────────────────────────────────┘
```

| 标题 | 按钮 | 含义 |
|---|---|---|
| **Initialize Console** | **Create admin** | 系统里**还没有管理员**。你现在输入的用户名密码，就是**正在创建**的管理员账号 |
| **Admin Login** | **Sign in** | 已经有管理员了，这是正常登录 |

**卡片下面那行说明文字（`Sign in before accessing service operations and token controls.`）在两种模式下是一模一样的，在 Initialize 模式下它是误导性的 —— 忽略它，只看标题和按钮。**

### 2.3 关键点：不要按「默认密码」去猜

- 这个系统**没有出厂默认密码**。第一次打开时 `/data/admins.json` 根本不存在。
- 用户名框预填了 `admin`（前端默认值，**可以改**）。密码框是空的，你输入什么就是什么。
- **密码没有复杂度校验**，只校验非空。请自己用强密码（这把密码等于全部运维权限）。
- 用户名/密码任一为空就点按钮 → 顶部红条 `username and password are required.`。
- 点 **Create admin** 成功后**自动登录**，不需要再登录一次，直接进 Dashboard。
- 登录态是 cookie session，**8 小时后过期**，过期后页面会回到 Admin Login，重新登录即可（不影响任何数据）。

### 2.4 部署完成后立刻做这一步

**在 Console 起来到你设置管理员之间，任何能打开这个 URL 的人都能抢先创建管理员并拿到全部运维权限。** 所以：部署脚本跑完、Caddy 证书签发好，第一件事就是打开 Console 建管理员，不要晾着过夜。

### 2.5 确认当前处于哪种状态（不用打开浏览器）

```bash
curl -s https://console.<PUBLIC_HOST>/api/console/setup
```

这个接口**不需要任何认证**（它就是给前端判断显示哪个表单用的）。

- 期望输出（未初始化）：`{"initialized":false}`
- 期望输出（已初始化）：`{"initialized":true}`
- **失败时**：

| 现象 | 怎么办 |
|---|---|
| 连接超时 / 无响应 | 按顺序查：网卡 NSG → **子网 NSG**（最容易漏的一层）→ VM 电源状态 → 容器是否在跑。两层 NSG 是独立的，缺一不可 |
| 证书错误 | Caddy 还没签发完，等 1–2 分钟重试；一直不行看 `docker compose logs caddy` |
| 返回 HTML 而不是 JSON | 你打到了别的服务，确认域名前缀是 `console.` 不是 `api.` |
| 返回 502 | Caddy 通了但 console 容器没起来，`docker compose ps` / `docker compose logs console` |

### 2.6 已经初始化过、但界面又显示 Initialize Console

判定条件是：`/data/admins.json` 里没有任何 `enabled: true` 的记录（文件被删、卷被重建、或内容被改坏）。这时**任何人都能重新抢占管理员**。立即：确认没有外人访问过 → 自己马上创建管理员 → 检查 Proxy Accounts 和 Account Pools 页数据是否还在（这两份数据在 `proxy-data` 卷里，和 Console 的 `console-data` 卷是分开的，通常不受影响）。

### 2.7 忘记管理员密码

界面上**没有找回入口**。Settings 页的改密要求先输入当前密码。

恢复思路（**源码判读，本环境未实测**）：管理员凭据只存在 `/data/admins.json`（由 `ADMINS_FILE` 环境变量指定，compose 里写死为 `/data/admins.json`，挂在 `console-data` 卷）。Console 每次调用都从磁盘重读这个文件，所以删掉后**刷新页面**就会回到 Initialize Console 状态，不需要重启容器。

```bash
# 在 VM 的部署目录下执行（实测部署目录为 /opt/ghcp-pool）
docker compose exec console rm -f /data/admins.json
```

- 期望：命令无输出（成功），刷新浏览器后出现 `Initialize Console`。
- 镜像是 `node:22-bookworm-slim`，**有 shell 和 `rm`**（已确认 Dockerfile）。
- 只影响管理员凭据，**不影响账号、账号池、统计数据**（那些在 proxy 容器的卷里）。
- ⚠️ 删完到你重新创建管理员之间，Console 处于「谁都能抢」的状态，动作要快。

---

## 3. 全局布局与导航

```
┌──────────────────┬───────────────────────────────────────────────────────────────┐
│ GHCP API Console │  Account Pools                             [local]  [Logout]  │ ← 顶栏（吸顶）
│ provided by ...  │  One exposed identity backed by many accounts, ...            │
│                  ├───────────────────────────────────────────────────────────────┤
│ ▸ Dashboard      │                                                               │
│ ▸ SSO Users      │                                                               │
│ ▸ AI Credits U.. │                        内容区                                  │
│ ▸ Request Stats  │                （随左侧选中项整页替换）                          │
│ ▸ Proxy Accounts │                                                               │
│ ■ Account Pools  │ ← 当前页高亮：深底白字                                          │
│ ▸ Login Tasks    │                                                               │
│ ▸ Settings       │                                                               │
│ ▸ Error Diagnos..│                                                               │
│ ▸ Diagnostics    │                                              ┌──────────────┐ │
│                  │                                              │ 已创建账号池  │ │ ← toast
└──────────────────┴───────────────────────────────────────────────└──────────────┘─┘
                                                                    右下角，4 秒后消失
```

| 元素 | 说明 |
|---|---|
| 左侧导航 | 10 个页面，点一下整页替换。**浏览器窗口宽度小于 1024px（Tailwind `lg` 断点）时左侧栏整个隐藏**，改用顶栏右侧出现的下拉框切换页面 |
| 顶栏标题 + 描述 | 就是当前页的名字和一句话说明，只读 |
| `local` 徽章 | **写死的字符串**，跟实际部署环境无关。不要拿它判断连的是不是生产 |
| **Logout** | 退出登录，回到 Admin Login |
| 右下角提示条（toast） | 操作结果。黑底白字=成功，橙底=警告，红底白字=错误。**4 秒后自动消失，不留历史**。做批量操作时别走开 |
| 地址栏 | 页面用 URL hash 记录，例如 `https://console.<PUBLIC_HOST>/#pools`。可以直接收藏/发给别人 |

各页对应的 hash：`#dashboard` `#users` `#budgets` `#stats` `#accounts` `#pools` `#tasks` `#settings` `#error-diagnostics` `#diagnostics`。

> 各页数据都是**打开该页时加载一次**。大部分页面有 Refresh / 刷新按钮；**Dashboard 没有**，要刷新只能切走再切回，或刷新整个浏览器页面。

---

## 4. 逐页说明

### 4.1 Dashboard（`#dashboard`）

**干什么**：一屏看健康度。**什么时候用**：每次登录先看一眼；有人报「不好使了」时第一站。

```
┌─────────────┬─────────────┬─────────────┬─────────────┐
│Proxy accounts│ SSO users  │Login failures│Recent tokens│
│      3      │      3      │      0      │   1,234,567 │
│ valid: 3    │ ...         │20 recent ...│in / out /...│
└─────────────┴─────────────┴─────────────┴─────────────┘
┌────────────────────────────────────────────────────────┐
│ Recent failed login tasks        （表格，最多 5 行）      │
├────────────────────────────────────────────────────────┤
│ Recent failed proxy requests     （表格，最多 5 行）      │
└────────────────────────────────────────────────────────┘
```

| 卡片 | 数字是什么 | 下面那行小字 |
|---|---|---|
| Proxy accounts | 已接入的账号数（**只取前 100 个**） | 按 Copilot OAuth 状态分组计数，如 `valid: 3` |
| SSO users | SSO 用户数（**只取前 100 个**） | 按 EMU 同步状态分组计数 |
| Login failures | 最近 20 个登录任务里 `failed` 的个数 | `20 recent task(s)` |
| Recent tokens | **最近 100 条请求**的 token 合计（input + output + cache） | `in X / out Y / cache Z (input A / write B)` |

**重要**：这四个数字都是「最近 N 条」的采样，**不是账单，不是全量**。别拿它对账。某个卡片的小字变成红色错误消息，说明那一路 API 调不通，去 Diagnostics 页看是哪个服务断了（四路是独立加载的，断一路不影响其余三个）。

两张表格只显示**失败**的记录，各最多 5 行，是 Login Tasks / Request Stats 两页的摘要版。

---

### 4.2 SSO Users（`#users`）

**干什么**：管理本地 SSO 用户，以及（在完整企业环境下）把它们同步成 GitHub EMU 托管用户、分配 Copilot 席位。

> ⚠️ **本部署下的限制（重要）**：账号池环境用的是「导入已有 OAuth token」模式，`.env.pool` 里的 `SCIM_BASE_URL` / `SCIM_TOKEN`（值就是 `not-used-in-import-mode`）/ `ENTERPRISE_SLUG` 只是为了让容器能启动，**不是可用的企业配置**。因此这一页上所有跟 GitHub 打交道的按钮（Sync GH login / Assign seat / Remove seat / Suspend / Delete GH login / Import from GH）在本环境**大概率直接报错**。你真正会用到的只有：**Create user**、**Import CSV**、**Batch create**、**Edit**。

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ [Search SSO user, email, or GH login       ] [Search]                        │
│              [3 / 50 users - 47 remaining] [Batch create][Import CSV]        │
│                                            [Import from GH][Create user]    │
├──────────────────────────────────────────────────────────────────────────────┤
│ 0 users selected                                        [Clear selection]    │ ← 批量操作条
│ GitHub sync        Copilot           GH account        Local account         │
│ [Sync GH login]    [Assign seat]     [Suspend]         [Delete Users]        │
│ □ Also assign ...  [Remove seat]     [Delete GH login]                       │
├──────────────────────────────────────────────────────────────────────────────┤
│ □ │SSO user│Email│Role│GH login│Status│Copilot seat│Updated│Actions           │
│ □ │demo01  │...  │user│ -      │...   │ ...        │ ...   │[Edit]           │
└──────────────────────────────────────────────────────────────────────────────┘
                                          Page 1 of 1, 3 total  [Previous][Next]
```

| 元素 | 含义 / 何时用 |
|---|---|
| 搜索框 + Search | 服务端搜索，每页 25 条；翻页会清空当前选择 |
| 容量药丸 | 有上限时显示 `3 / 50 users - 47 remaining`；不限时显示 `3 users / unlimited`。到上限时药丸变红，且 **Create user 和 Batch create 变灰**。上限在 Settings → SSO runtime settings → Maximum SSO users |
| **Create user** | 弹窗 `Create SSO user`，说明文字 `Password defaults to SSO user when left blank.`。字段：SSO user、Password、Email、Role。成功 toast `SSO user created.` |
| **Batch create** | 弹窗 `Batch create SSO users`，批量生成一组用户，可勾选「建完就同步到 GH」（**本环境别勾**）。成功 toast `Batch create completed.` |
| **Import CSV** | 文本框预填表头 `ssoUser,password`（也接受只有 `ssoUser` 一列）。**已存在的用户会被改密码**。成功 toast `Import completed.` |
| **Import from GH** | 从 GitHub SCIM 拉取比对，先 Preview 再 Apply。本环境不可用 |
| 表格 Status 列 | EMU 同步状态；本环境通常一直是初始值 |
| 表格 Copilot seat 列 | 席位状态徽章；旁边有红色 `!` 时把鼠标停上去看错误原因 |
| **Edit** | 弹窗 `Edit <用户名>`，改 Email / 新密码 / 角色，密码留空表示不改 |
| 批量操作条 | **选中行之后才可用**。所有带删除语义的操作都会先弹确认框，确认框里写明会连带删掉什么 |

**⚠️ 用户名会被自动改写（源码级规则，`sanitizeSsoUser`）**：你在 Create user 里填什么，实际存下来的不一定是什么。依次做四件事：

1. 去首尾空格；
2. **全部转小写**；
3. 砍掉 `@` 及其后面全部内容（填邮箱只会留下 `@` 前面那截）；
4. 把 `a-z 0-9 . _ -` 之外的字符替换成 `-`，去掉首尾的 `-`，**截断到 32 字符**。

所以：`Demo01` → `demo01`，`Demo.01@contoso.com` → `demo.01`。**建用户时就直接用小写、纯 ASCII 的短名字**，避免后面导入 token 时对不上（见 [4.5](#45-proxy-accountsaccounts)）。

---

### 4.3 AI Credits Usage（`#budgets`）

**干什么**：读 GitHub 企业账单接口，看 Copilot AI Credits 消耗和席位成本。

> ⚠️ **本部署下未验证 / 大概率不可用**：需要真实的企业账单 API 权限。打开这页很可能直接是红色错误条。这不影响账号池运行，忽略即可。

页面元素：右上 **Refresh usage** 按钮；五张卡片（上月用量 / 本月用量 / `Projected this month` / `Assigned seats` / `Seat monthly cost`）；下方一行 `Enterprise` / `Last fetched` / `Source` 信息。首次打开会先尝试读缓存。

---

### 4.4 Request Stats（`#stats`）

**干什么**：查 Proxy 侧每一次上游请求的结果和 token 用量。**什么时候用**：对用量、查失败、确认池分配是否按预期在轮换。

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ [Identity or GH login] [Model] [All outcomes ▾] [Refresh]                     │
├──────────────────────────────────────────────────────────────────────────────┤
│Requested│Identity│GH login│Path│Model│Outcome│Input│Output│Cache input│       │
│         │        │        │    │     │       │     │      │Cache write│      │
│         │        │        │    │     │       │     │      │Cache total│Total│Failure│
├──────────────────────────────────────────────────────────────────────────────┤
│09-08 10:│demo01  │  -     │/v1/│claude│success│2000 │ 150  │ 1716 │ 0 │1716│…│
└──────────────────────────────────────────────────────────────────────────────┘
```

共 13 列：Requested、Identity、GH login、Path、Model、Outcome、Input、Output、Cache input、Cache write、Cache total、Total、Failure。

| 列 | 含义 |
|---|---|
| Requested | 请求时间（浏览器本地时区） |
| **Identity** | **池模式下这里是实际承接请求的成员账号**（如 `demo01`），**不是池名**。（注意：Error Diagnostics 页的 Identity 列相反，见 [4.9](#49-error-diagnosticserror-diagnostics)） |
| Path | `/v1/messages`、`/chat/completions`、`/responses`、`/v1/models`、`/v1/messages/count_tokens` 之一 |
| Outcome | 绿色 `success` / 红色 `failed`，判定就是上游 HTTP 响应是否 2xx |
| Input / Output | 普通输入、输出 token |
| Cache input / Cache write / Cache total | 缓存命中读取 / 写入缓存 / 两者之和。**跨账号命中的缓存也计在这里**（实测 demo01 写入 2000，demo02 读到 `cache_read=1716`） |
| Total | Input + Output + Cache total |
| Failure | 失败原因；上游返回非 2xx 时是 `HTTP <状态码>`（如 `HTTP 429`）。截断显示，鼠标停上去看全文 |

**必须知道的三条限制：**

1. **没有时间范围筛选器。** 页面一次性拉最近 1000 条，三个筛选框（Identity / Model / Outcome）都是**前端在这 1000 条里过滤**，改筛选条件不会重新请求后端。要按时间段统计只能自己看 Requested 列，或走 [第 8 节](#8-界面上做不到必须走命令行的事)的命令行。
2. **每个账号只保留最近 N 条。** 由 `REQUEST_STATS_PER_ACCOUNT_LIMIT` 控制，写入新记录时会顺手删掉超出的旧记录。**本环境 `.env.pool` 里设的是 200**（compose 默认值只有 2）。所以「上周的数据」很可能已经不存在了。
3. **表格里没有「池」这一列。** 后端返回的 JSON 里确实有 `poolId` 字段，但界面没有渲染它。要按池汇总，只能查库或调 API。

---

### 4.5 Proxy Accounts（`#accounts`）

**干什么**：看每个 identity 对应哪个 SSO 用户 / GH 账号、Copilot OAuth token 是否有效；导入 token；手动触发重新授权。

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Proxy accounts                                                               │
│ Identity header mappings, token status, and manual recovery actions.         │
│      [Search identity, SSO user, or GH login][Import Copilot OAuth tokens]   │
│                                              [Search] [Refresh list]         │
├──────────────────────────────────────────────────────────────────────────────┤
│ 0 selected      [Details] [Reauthorize Copilot] [Delete selected] [Clear]    │ ← 蓝色操作条
├──────────────────────────────────────────────────────────────────────────────┤
│ □ │Header identity│SSO user│GH login│Copilot OAuth│Updated                    │
│ □ │demo01         │demo01  │ -      │ valid       │09-08 10:12                │
│ □ │demo02         │demo02  │ -      │ valid       │09-08 10:12                │
└──────────────────────────────────────────────────────────────────────────────┘
```

| 元素 | 含义 / 注意 |
|---|---|
| **Header identity** | 就是 `X-User-Identity` 头里的值。池的成员就是从这一列里选的 |
| **Copilot OAuth** | 状态 + 时间。**只有 `valid` 的账号加进池才有意义**（非 valid 的成员会让落到它的请求直接 503，见下） |
| **Details**（需正好选中 1 行） | 弹窗 `Account <identity>`，显示 Header identity / SSO user / GH login / Copilot OAuth / OAuth updated，下半部分是**该账号最近 20 条**请求统计 |
| **Reauthorize Copilot**（需正好选中 1 行） | 弹窗要求输入该用户的 **SSO password** 和 **SSO type**（Custom / Azure），创建一个 Device Flow 重新授权任务。本环境是导入 token 模式，这条链路**未验证** |
| **Delete selected** | ⚠️ 见 [第 7 节](#7-风险操作清单点之前必须确认什么) |
| **Import Copilot OAuth tokens** | 见下 |

**Import Copilot OAuth tokens 弹窗**：

- 说明文字：`CSV format: name,copilotOauthToken. Tokens must come from the OpenCode OAuth client and are validated against Copilot /models before storage.`
- 橙色提示条：`Create missing SSO users manually before importing. Validated tokens overwrite existing credentials and are never echoed back.`
- 文本框预填 `name,copilotOauthToken`。**表头两列去掉空格后必须精确等于 `name` 和 `copilotOauthToken`，大小写敏感**；表头不对则整批不导入，只返回一条 `CSV header must be exactly: name,copilotOauthToken`。
- 每行一个账号，正好两列。同一批里 name 重复（忽略大小写）会被判 `Duplicate name`。
- 点 **Import** 后，弹窗下方出现 `Batch <id>: 1 success, 0 failed` 和逐行结果 `Line 2: demo01 - success - ...`；同时右下角 toast `Copilot OAuth token import completed.`
- token 本身**不会**被回显。已存在的凭据会被覆盖。

**逐行失败信息与对应处置（源码里的原文）：**

| 提示 | 原因 | 怎么办 |
|---|---|---|
| `SSO user "<name>" was not found. Create it manually in SSO Users before importing this token.` | SSO 用户不存在 | 先去 SSO Users 建，**用小写**（SSO 侧查找忽略大小写，但**建用户时会强制小写**） |
| `Copilot OAuth token validation failed: token is invalid or expired.` | 上游 401 | 换一个有效 token |
| `Copilot OAuth token validation failed: account has no Copilot access or is blocked by organization policy.` | 上游 403 | 该账号没有 Copilot 权限 |
| `Expected two columns: name,copilotOauthToken` | 这一行列数不对 | 检查是不是少了逗号或 token 里带逗号（带逗号要用双引号包起来） |

> ⚠️ **大小写只在一个方向被纠正**：SSO 建用户会强制小写，但**导入时 CSV 里的 `name` 会被原样用作 proxy 账号的 identity**，而 identity 的查表是**大小写敏感**的。如果 CSV 写 `Demo01`、SSO 用户是 `demo01`，导入能成功（SSO 查找不敏感），但你会得到一个叫 `Demo01` 的账号，之后加池成员、发请求都必须写 `Demo01`。**统一全小写**是最省事的做法。

---

### 4.6 Account Pools（`#pools`）

见 [第 5 节](#5-account-pools-页详解本次新增)，单独详讲。

---

### 4.7 Login Tasks（`#tasks`）

**干什么**：看自动登录 / token 刷新任务的执行情况。**什么时候用**：某个账号 OAuth 状态不是 valid，想知道后台在干什么、卡在哪。

| 元素 | 含义 |
|---|---|
| 搜索框 + 状态下拉（All statuses / pending / running / success / failed / cancelled）+ Search / Refresh | 服务端筛选，每页 25 条 |
| 表格列 | Task ID、Identity、SSO user、GH login、Status、Attempts、Failure、Created |
| **Cancel selected** | 只对未结束（pending/running）的任务有效；确认框 `Cancel N selected login task(s)?` |
| **Retry failed task** | 只在**正好选中 1 个 failed 任务**时可用。弹窗要求输入 SSO password（系统不存密码）和 SSO type（Custom / Azure）。成功 toast `Login task retry queued.` |
| **Delete selected** | pending / running 的任务**不能删**（按钮会被禁用并提示）；确认框 `Delete N selected login task(s)? This cannot be undone.` |

本环境（导入 token 模式）正常情况下这一页应该是空的。**如果这里突然冒出一堆任务，多半是有人把某个池「停用」了**，见 [7.3](#73-停用池的连锁反应)。

---

### 4.8 Settings（`#settings`）

三张卡片，在宽屏下按**两列**网格排列（不是三张并排）：

**① Console administrator password**
改当前登录管理员的密码。三个框：Current password / New password / Confirm new password，右下 **Change password**。改完当前会话**不会掉线**。前端先做三项校验，失败时直接在卡片里显示红字：

| 情况 | 提示原文 |
|---|---|
| 有空项 | `Current password, new password, and confirmation are required.` |
| 两次新密码不一致 | `New password and confirmation do not match.` |
| 新密码和旧的一样 | `New password must be different from the current password.` |
| 当前密码错 | 由后端返回，卡片红字显示 |

成功 toast：`Console administrator password changed.`

**② SSO runtime settings**（存在 `sso.sqlite`，改完不用重启 SSO）

| 字段 | 允许范围 | 影响 |
|---|---|---|
| Maximum SSO users | 1–1000000，**留空 = 不限** | SSO 用户数量上限。**这个值卡着 SSO Users 页的 Create / Batch create 按钮** |
| Fallback user prefix | 文本 | 自动生成用户名时的前缀 |
| Default email domain | 文本 | 自动生成邮箱的域名 |
| Sync EMU concurrency | 1–20 | 批量同步并发数 |
| SCIM request delay (ms) | 0–60000 | SCIM 调用节流。本环境不走 SCIM，改了没意义 |
| SCIM max retries | 0–10 | 同上 |
| SCIM retry base delay (ms) | 0–60000 | 同上 |

成功 toast：`SSO settings saved and applied.`

**③ Login runtime settings**（存在 `login.sqlite`；说明文字明确写了「运行中的任务保持启动时的快照」）

| 字段 | 允许范围 | 影响 |
|---|---|---|
| Login concurrency | 1–20 | 同时跑几个 Playwright 登录任务 |
| Authentication timeout (ms) | 5000–600000 | 单个任务超时 |
| ☐ Enable account debug logs for new tasks | — | 只对**新建**任务生效 |
| ☐ Save debug artifacts for new tasks | — | 同上；会产生截图等文件，占磁盘 |

成功 toast：`Login settings saved and applied.`

两张运行时设置卡片底部都有 `Version N - updated <时间>` 和 **Save and apply**。**并发保护**：如果别人在你之前改过（版本号变了），保存会失败（HTTP 409），页面**自动重载最新值**并红字提示 `SSO settings changed in another session. The latest values were reloaded.`（Login 卡片是 `Login settings changed in another session. ...`）—— 这时你的输入已被覆盖，要重填。

---

### 4.9 Error Diagnostics（`#error-diagnostics`）

**干什么**：Copilot 上游失败的**完整现场快照**，含请求头、格式化后的请求体、可直接复现的 curl 命令、以及真正发给上游的内容。**什么时候用**：Request Stats 里看到 failed 但 Failure 一行看不出原因时。

| 元素 | 含义 |
|---|---|
| 徽章 `Collection enabled` / `Collection disabled` | 采集开关（`PROXY_ERROR_DIAGNOSTICS_ENABLED`，默认 true）。disabled 时整页只有一条错误提示 `Proxy error diagnostics collection is disabled by configuration.` |
| 徽章 `Sensitive data redacted` / **`Unredacted records`** | **本环境是 `Unredacted records`**（`PROXY_ERROR_DIAGNOSTICS_REDACT` 默认 false，且 `.env.pool` 里没设）。意味着记录里**可能包含 Copilot token、API key 等明文** |
| 表格列 | Time、Identity、Route / model、Failure（`http` / `fetch` / `stream`）、Status、Body sizes、Actions |
| **Identity 列** | ⚠️ 这里是**请求头里的 identity（池模式下就是池名）**，不是实际成员账号。Request Stats 页恰好相反。两页对照看时别搞混 |
| **Refresh** | 重新拉当前页 |
| **Details** | 弹窗预览，**最多显示 20000 字符**，超出会在末尾标注 `[Preview truncated; download the record for complete data.]`；弹窗里还有 **Download complete log** |
| **Download** | 下载完整日志文件 |
| **Clear all** | ⚠️ 清空全部记录，不可撤销，见第 7 节。没有记录或采集关闭时按钮是灰的 |

⚠️ **下载的文件不要直接发给客户或贴进工单**，先自己过一遍脱敏。

---

### 4.10 Diagnostics（`#diagnostics`）

**干什么**：一键探测 Console 到三个内部服务的连通性和内部令牌是否对得上。**什么时候用**：任何页面报「加载失败」时，先来这里看是哪一路断了。

打开时自动跑一次，右上 **Run checks** 可重跑。四张卡片，每张一个探测项：

| 卡片 | 实际打的接口 | Failed 时先查什么 |
|---|---|---|
| Proxy accounts | Proxy `/api/accounts` | proxy 容器是否 healthy；`INTERNAL_API_TOKEN` 两边是否一致 |
| SSO users | SSO `/api/users` | sso 容器是否 CrashLoop —— **最常见原因是缺 SAML 证书**（`/certs/idp-cert.pem` 和 `idp-key.pem`），导入 token 模式下用自签证书即可 |
| Login tasks | Login `/api/tasks` | login 容器状态 |
| Request stats | Proxy `/api/request-stats` | 同第一行 |

绿色 `OK` = 通；红色 `Failed` + 下方红字 = 具体错误消息（`internal_auth_failed` 就是令牌不一致）。

---

## 5. Account Pools 页详解（本次新增）

这是唯一一个全中文的页面，也是账号池运维的主战场。

### 5.1 整页布局

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ 什么是账号池                                                                   │  ← ① 说明卡片
│ 把一个对外暴露的 identity 映射到后台多个真实账号……prompt 缓存不受策略影响……      │
│                                                                              │
│ 新建池（这个名字就是客户端要用的 identity）                                      │
│ [ team-alpha                    ] [创建池] [清理过期会话绑定] [刷新]             │
└──────────────────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────────────────┐
│ team-pool  [启用] [最少使用（推荐）]  可用 2 / 2 个账号     [展开] [删除池]       │  ← ② 池卡片（收起态）
└──────────────────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────────────────┐
│ other-pool [已停用（回落为普通身份）] [会话粘性] 可用 0 / 1 个账号 [展开][删除池] │
└──────────────────────────────────────────────────────────────────────────────┘
```

**① 顶部说明卡片**里有一句关键结论，值得记住（界面原文）：

> **prompt 缓存不受策略影响** —— 实测缓存在 Anthropic 组织层共享，跨 GHCP 账号命中，因此换账号不会丢缓存，可以放心按负载均匀分摊。

这条与直觉相反，是选 `least-loaded` 作默认策略的依据。实测数据：demo01 写入缓存 2000 token 后，demo02 发相同请求直接 `cache_read=1716` 命中。

> 同一段说明里还有一句「某个账号被限流会自动冷却并切换，请求不中断」。**这句 UI 文案对「不中断」的说法偏乐观**：源码里当前这一次请求不会自动改用别的账号重发（故障转移用的 `exclude` 参数在 HTTP 请求路径上没有被使用），切换发生在**下一次请求**。详见 [5.3 的故障转移小节](#故障转移行为三种策略都一样)。

**「新建池」输入框**：输入的名字**就是客户端要用的 identity**，也就是 LiteLLM 虚拟 key 里 `metadata.trusted_user_id` 要填的值。

- 命名规则（服务端正则 `^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$`）：首字符必须是字母或数字，其余可用 `A-Z a-z 0-9 . _ : @ -`，**总长最多 128 字符**。**中文、空格、斜杠会被拒绝**，返回 400 `pool_id_invalid`。
- **池名不能和已有账号的 identity 重名**，否则返回 409 `pool_id_conflicts_with_account`（会让请求路由产生二义）。
- 输入框为空时「创建池」按钮是灰的；创建中按钮文字变成 `创建中…`。
- 成功后 toast：`已创建账号池 <池名>`，并且该池**自动展开**。
- 界面创建时**不传任何参数**，一律用默认值（策略 `least-loaded`、1800 / 300 / 3）。要一次性指定参数得走 API（见第 8 节）。

**「清理过期会话绑定」**：删掉 `proxy_session_affinity` 表里 `expires_at` 已经过去的绑定记录，纯粹是清垃圾。toast：`已清理 N 条过期会话绑定`。

- 什么时候点：库里绑定记录堆积、或你想确认没有残留绑定。
- **只删已过期的，不影响未过期的绑定，不会打断正在进行的会话**，可以放心点。
- 只在 `sticky-affinity` 策略下才有实际意义 —— 另外两种策略根本不写绑定记录。

**「刷新」**：重新拉取池列表和账号列表。**加了新账号后下拉框里看不到，先点这个。**

如果一个池都没有，会显示：`还没有账号池。在上面创建一个，然后把已接入的账号加进去。`

### 5.2 池卡片（收起态）的四个信息

| 元素 | 取值 | 含义 |
|---|---|---|
| 池名 | 粗体大字，**可点击**（等同于「展开/收起」） | 客户端用的 identity |
| 启用徽章 | 绿色 `启用` / 橙色 `已停用（回落为普通身份）` | 见 [7.3](#73-停用池的连锁反应) |
| 策略徽章 | 蓝色 `最少使用（推荐）` / `会话粘性` / `轮询` | 当前选择策略 |
| 可用数 | `可用 2 / 2 个账号` | 分子=当前可用成员数，分母=成员总数。**分子会随冷却实时变化** |

「可用」的判定（后端算的，页面每次加载时重算）：成员状态是 `active`，**或者**状态是 `cooling` 但 `冷却至` 已经过了（冷却到期是自动生效的，不需要后台任务解冻）。`disabled` 的成员永远不算可用。

**同一时间只能展开一个池** —— 展开另一个池会自动收起当前的。

**分子变成 0 就是事故**：池里全员冷却，请求会失败并返回 `PoolAllCoolingError`（带 `retryAfterSeconds`，取最早解冻的那个）。

### 5.3 展开后的四块

```
│ team-pool  [启用] [最少使用（推荐）]  可用 2 / 2 个账号     [收起] [删除池]       │
├──────────────────────────────────────────────────────────────────────────────┤
│ ┌── ① 四个配置项 ──────────────────────────────────────────────────────────┐ │
│ │ 会话绑定时长（秒） │ 冷却时长（秒）  │ 失败阈值      │ 选择策略              │ │
│ │ [1800    ]        │ [300    ]      │ [3     ]     │ [最少使用（推荐）▾]    │ │
│ │ 同一会话在此时间内 │ 账号遇到 429 后 │ 连续失败几次后│ 每次挑最久未使用的… │ │
│ │ 固定用同一账号     │ 暂停多久        │ 进入冷却…    │                      │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
│                     ↑ 改了数字后，输入框右边才会冒出 [保存] 按钮                 │
│ ┌── ② 加成员 / 池开关 ────────────────────────────────────────────────────┐ │
│ │ 添加成员账号                                                              │ │
│ │ [选择一个已接入的账号…            ▾] [加入池] [停用池]                     │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
│ ┌── ③ 成员表格 ───────────────────────────────────────────────────────────┐ │
│ │ 账号   │状态    │权重│连续失败│冷却至           │最近使用        │操作      │ │
│ │ demo01 │[可用]  │ 1  │  0    │  —             │09-08 10:12:33 │[移出]    │ │
│ │ demo02 │[冷却中]│ 1  │  1    │09-08 10:20:00  │09-08 10:15:01 │[解除冷却]│ │
│ │        │        │    │       │                │               │[移出]    │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
│ ④ 客户端用法：把 Virtual Key 的 trusted_user_id 设为 team-pool，请求即自动分配  │
└──────────────────────────────────────────────────────────────────────────────┘
```

#### ① 四个配置项 —— 每个改了会怎样

前三个是数字输入框：**改动后才会在右边冒出「保存」按钮**，不改就没有按钮。填非数字、0、负数时保存按钮是灰的；填小数会被**截断取整**（`2.7` 存成 `2`）。第四个是下拉框，**选中即生效，没有保存按钮**。

> 后端对这三个数字只接受**正整数**，其它值（0、负数、非数字）会被**静默忽略**——字段保持原值、接口仍然返回 200。所以走 API 改配置时，改完一定要回读确认。

| 配置项 | 默认值 | 界面上的说明文字 | 改大 / 改小的影响 | 什么时候需要动 |
|---|---|---|---|---|
| **会话绑定时长（秒）** | 1800（30 分钟） | 同一会话在此时间内固定用同一账号 | 改大=绑定更久，负载更不均；改小=更早重新分配 | ⚠️ **只在 `sticky-affinity` 策略下生效**。`least-loaded` 和 `round-robin` 根本不读也不写绑定记录，改这个数字对它们**完全没有影响** |
| **冷却时长（秒）** | 300（5 分钟） | 账号遇到 429 后暂停多久 | 改大=更保守，可用成员减少的时间更长；改小=更快放回来，但可能立刻又撞限流 | 上游限流窗口明显比 5 分钟长时改大 |
| **失败阈值** | 3 | 连续失败几次后进入冷却（429 立即冷却，不受此限） | 改小=更敏感，容易误伤；改大=更迟钝，坏账号会多接几次请求 | ⚠️ **429 / 402 不受这个值约束，一次就立刻冷却** |
| **选择策略** | `least-loaded`（最少使用） | 随当前**已保存**的策略变化（见下表「界面提示」列） | 见下表 | 见下表 |

保存成功的 toast 分别是：`已更新会话时长` / `已更新冷却时长` / `已更新失败阈值` / `已更新选择策略`。

**三种策略的实际行为（源码级）：**

| 下拉选项 | 内部值 | 实际算法 | 权重生效？ | 界面提示（选中后显示） |
|---|---|---|---|---|
| 最少使用（推荐） | `least-loaded` | 在可用成员里选 **`最近使用` 时间最早**的那个（从未用过的算「最早」，会被优先选中） | ❌ 忽略权重 | 每次挑最久未使用的账号，负载最均匀。多租户共用一个池时用这个 |
| 会话粘性 | `sticky-affinity` | Rendezvous（HRW）哈希：同一 sessionKey 恒定落到同一成员；命中已有绑定则直接复用并**续期** | ✅ 生效 | 同一会话固定落在同一账号。需要按会话审计追溯、或客户端用了 /responses 的 previous_response_id 这类有状态接口时用 |
| 轮询 | `round-robin` | 成员按名字排序后，用 sessionKey 的哈希取模 | ❌ 忽略权重 | 按会话哈希分配，同一会话结果稳定但不看负载 |

> 下拉框下面那行提示显示的是**已保存策略**的说明，不是你刚选中还没保存的（不过策略是选中即保存，所以正常情况下两者一致）。

> 补充说明（避免读代码时被误导）：`src/proxy/src/pool/poolTypes.ts` 顶部的注释还停留在改造前的假设，把 `sticky-affinity` 写成默认、把 `least-loaded` 写成「仅用于对照测试」。**以 `POOL_DEFAULTS` 和界面为准：默认是 `least-loaded`**。注释没跟着缓存实测结论更新。

**故障转移行为（三种策略都一样）：**

| 事件 | 行为 |
|---|---|
| 上游返回 429 或 402 | **立刻**冷却该成员（`forceCooldown`），不用攒够失败次数 |
| 其他错误 | 累计 `连续失败`，达到失败阈值才冷却 |
| 一次成功 | `连续失败` 清零，状态回 `active`，`冷却至` 清空，`最近使用` 刷成当前时间 |
| 冷却到期 | 自动视为可用，不需要人工干预（状态字段可能还写着 `cooling`，界面会显示蓝色 `冷却已到期`） |
| 所有成员都在冷却 | 抛 `PoolAllCoolingError`，带 `retryAfterSeconds`（取最早解冻的那个） |

> ⚠️ **两条源码判读（未实测，需现场确认），会影响你对界面的判断：**
>
> 1. **这一次失败的请求不会自动改用别的账号重发。** 选择器支持传 `exclude` 做同请求内故障转移，但 HTTP 请求路径上没有使用它。客户端会拿到那次失败的响应，切换体现在**下一次请求**。
> 2. **推理请求本身返回 429 时，成员不一定会进冷却。** 代码在拿到上游响应之后、把响应转发给客户端之前就调用了「成功」上报（清零连续失败 + 刷新最近使用），随后才按 HTTP 状态码记统计。真正会把成员打进冷却的是**模型能力校验阶段**（调 Copilot `/models`，结果有缓存）拿到的 429/402。
>    **实际观感**：Request Stats 里能看到一串 `failed / HTTP 429`，但 Account Pools 里那个成员的「连续失败」可能一直是 0、状态一直是「可用」。
>    **这时怎么办**：不要干等冷却，直接把该成员 **移出**池（见 [7.2](#72-不会弹确认框点了立即生效的最危险的一类)），等限流窗口过去再加回来。

**选择算法的实测性质**（Rendezvous 哈希，即 `sticky-affinity` 下）：同 sessionKey 必定同账号；10000 会话 / 100 账号，分布变异系数 10.4%；移除 1 个账号只重映射 1.0% 的会话且不波及无关会话；权重 8:1:1 实测分配为 80.4% / 9.4% / 10.2%。（对应 `tests/selector-check.cjs`）

**会话 key 是怎么定的**（决定「同一个会话」的边界，四级优先，取到就停）：

| 优先级 | 来源 | 说明 |
|---|---|---|
| 1 | `X-Session-Id` 请求头 | 客户端主动控制 |
| 2 | 请求体 `metadata.user_id` | Claude Code 会传 |
| 3 | system + 首条 user message 的前 4096 字节的 sha256 | 兜底，不需要客户端配合 |
| 4 | 固定兜底值 | 连 prompt 都取不到时（如 `/v1/models`），这类请求会稳定落到同一账号 |

`count_tokens` 与正式请求共用同一个会话 key，不会额外打散缓存。

#### ② 添加成员账号 / 停用池

| 元素 | 说明 |
|---|---|
| **下拉框** | 默认项 `选择一个已接入的账号…`。只列出**已接入、不在本池里、且名字不等于池名**的账号；账号名后括号里是它的 Copilot OAuth 状态（**状态是 `valid` 时不显示括号**，所以看到括号就说明这个账号有问题） |
| **加入池** | 未选账号时按钮是灰的。成功 toast：`已把 <账号> 加入 <池名>` |
| **停用池 / 启用池** | 切换池的 enabled，toast 为 `已停用该池` / `已启用该池`。⚠️ 后果严重，见 [7.3](#73-停用池的连锁反应) |

**下拉框里找不到某个账号的排查顺序：**

1. 页面数据旧了 → 点顶部**刷新**。
2. 它已经在本池里了 → 看下面的成员表格。
3. 它还没导入 → 去 Proxy Accounts 页确认；没有就先走 [6.1](#61-任务-a新接入一个-copilot-账号并加进池)。
4. 它的名字**正好等于池名** → 被有意排除了（池不能把自己当成员）。
5. **账号总数超过 100** → 这个页面只取前 100 个账号，超出的看不见。此时只能用 API 加成员（见第 8 节）。
6. 名字大小写对不上（见 [4.5](#45-proxy-accountsaccounts) 的大小写说明）。

加入成功后新成员的初始值固定是：状态 `可用`、权重 `1`、连续失败 `0`、冷却至 `—`、最近使用 `从未`。

> 服务端会校验：池必须存在（否则 404 `pool_not_found`）、成员账号必须已存在（否则 404 `account_not_found`）、**池不能把自己当成员**（400 `member_cannot_be_pool`）。

#### ③ 成员表格

如果没有成员，这里显示一行灰字：`这个池还没有成员 —— 加入账号后才能承接流量。`

| 列 | 含义 | 注意 |
|---|---|---|
| **账号** | 成员的 identity，就是 Proxy Accounts 页的 Header identity | 按账号名排序 |
| **状态** | 四种徽章，见下 | |
| **权重** | 相对权重 | ⚠️ **界面上改不了**（只能通过 API），而且**只在 `sticky-affinity` 策略下生效**，默认策略下这一列纯属展示 |
| **连续失败** | 连续失败计数 | 到达「失败阈值」就冷却；一次成功即清零。注意上面那条源码判读：纯推理 429 场景下这个数可能一直是 0 |
| **冷却至** | 冷却结束时间（浏览器本地时区），无冷却时显示 `—` | 到点自动可用，不用管 |
| **最近使用** | **上一次成功**被记账的时间，从未用过显示 `从未` | ⚠️ `least-loaded` 策略**就是按这一列排序选人的**（选最早的）。失败不会刷新这一列 |
| **操作** | `解除冷却`（**仅当状态不是「可用」时出现**，即 `cooling`/`disabled` 都会出现，包括蓝色的「冷却已到期」）、`移出`（始终存在，红色） | 有请求进行中时两个按钮都会短暂变灰 |

**状态徽章的四种取值：**

| 徽章 | 颜色 | 内部状态 | 含义 |
|---|---|---|---|
| `可用` | 绿 | `active` | 正常参与选择 |
| `冷却中` | 橙 | `cooling` 且冷却未到期 | 暂时不参与选择 |
| `冷却已到期` | 蓝 | `cooling` 且冷却时间已过 | **已经可以正常接请求了**，状态字段只是还没被下一次成功请求刷新。不用管，也不用点「解除冷却」 |
| `已停用` | 橙 | `disabled` | 人工停用（只能通过 API 设置），永远不参与选择 |

**「解除冷却」按钮的三个副作用（点之前必须知道）：**

1. 把状态改回 `active`、`连续失败` 清零、`冷却至` 清空 —— 这是你想要的。
2. ⚠️ **把「最近使用」刷成当前时间**。在默认的 `least-loaded` 策略下，这等于把它排到了队尾，短期内不会被选中。
3. ⚠️ **把「权重」重置为 1**。如果你之前通过 API 设过非 1 的权重，这一点会把它悄悄改掉（实现上 resume 复用了成员 upsert，没带 weight，于是回落到默认值 1）。

成功 toast：`已解除 <账号> 的冷却`。对 `已停用` 的成员同样有效，会把它变回可用。

**「移出」**：把成员从池里删掉，toast `已从池中移除 <账号>`。**不会删账号本身**，账号在 Proxy Accounts 页仍然存在。同时会**连带删掉该成员在这个池里的所有会话绑定记录**。**没有二次确认框，点了就执行** —— 见第 7 节。

#### ④ 底部提示

```
客户端用法：把 Virtual Key 的 trusted_user_id 设为 team-pool，请求即自动在池内分配。
```

这是连接 Console 和 LiteLLM 的那根线：LiteLLM 虚拟 key 的 `metadata.trusted_user_id` 填池名，`trusted_identity_hook` 会强制把 `X-User-Identity` 改写成它，Proxy 收到后查到这是个池，就走池分配。

**安全前提（实测过的）**：Proxy 的身份完全来自 `X-User-Identity` 请求头，同一个 `API_KEY` 分别发 `team-pool` / `demo01` / `demo02` 三种身份**全部返回 200**。**所以 Proxy 的 3000 端口绝不能直接暴露公网**，LiteLLM 的 hook 是整套多租户隔离唯一的安全边界（实测：无 key → 401；用 master key 直接推理 → 403；带伪造的 `X-User-Identity` 头 → 头被剥掉，仍按 key 元数据走池分配）。

---

## 6. 三个高频任务的完整点击路径

### 6.1 任务 A：新接入一个 Copilot 账号并加进池

**前提**：已经拿到该账号的 Copilot OAuth token（来自 OpenCode OAuth client；导入时服务端会拿它去调 Copilot `/models` 校验，无效的直接拒）。

| 步 | 在哪 | 点什么 | 期望看到 | 失败时怎么办 |
|---|---|---|---|---|
| 1 | 左侧 **SSO Users** | **Create user** | 弹窗 `Create SSO user` | 按钮是灰的 → 用户数到上限了，去 Settings 改 `Maximum SSO users` |
| 2 | 弹窗 | `SSO user` 填 `<账号名>`（**全小写、纯 ASCII、不超过 32 字符**），其余留空 → **Create user** | toast `SSO user created.`，列表里出现该用户，**且列表里显示的名字和你输入的一致** | ① 列表里的名字和你输入的不一样 → 被 `sanitizeSsoUser` 改写了（见 [4.2](#42-sso-usersusers)），后面所有地方都用**列表里显示的那个名字**；② 报重名 → 已经有了，跳到第 3 步 |
| 3 | 左侧 **Proxy Accounts** | **Import Copilot OAuth tokens** | 弹窗，文本框预填 `name,copilotOauthToken` | — |
| 4 | 弹窗文本框 | 在第二行粘贴 `<账号名>,<token>` → **Import** | 弹窗下方出现 `Batch <id>: 1 success, 0 failed` 和 `Line 2: <账号名> - success - ...`；toast `Copilot OAuth token import completed.` | ① 提示 `SSO user "<name>" was not found...` → 回第 1 步，注意名字要和 SSO 列表里显示的完全一致；② `CSV header must be exactly: name,copilotOauthToken` → 表头被改过；③ `token is invalid or expired` / `no Copilot access` → 换一个有效 token |
| 5 | **Proxy Accounts** 列表 | 关掉弹窗（必要时点 **Refresh list**） | 出现 `<账号名>` 一行，**Copilot OAuth 列是 `valid`** | 不是 valid → **先别加进池**。落到非 valid 成员的请求会直接 503 `oauth_not_ready`，而且这类失败**不会**被计入池的失败计数，在默认 `least-loaded` 下它会被反复优先选中 —— 等于把整个池搞坏 |
| 6 | 左侧 **Account Pools** | 目标池右侧 **展开** | 展开出四块内容 | — |
| 7 | 「添加成员账号」区 | 下拉框选中 `<账号名>` → **加入池** | toast `已把 <账号名> 加入 <池名>`；成员表新增一行（可用 / 权重 1 / 连续失败 0 / 冷却至 — / 最近使用 从未）；卡片头部可用数从 `N / N` 变成 `N+1 / N+1` | 下拉框里没有它 → 先点顶部**刷新**；还没有 → 按 [5.3 ②](#-添加成员账号--停用池) 的 6 条排查 |
| 8 | 验证 | 让客户端发一次请求，然后回 **Account Pools** 点顶部**刷新** | 该成员的「最近使用」从 `从未` 变成一个时间 —— **默认 `least-loaded` 策略下，「从未」排在最前面，新成员会被下一次请求优先选中** | 刷新后仍是 `从未` →（a）确认客户端用的虚拟 key 的 `trusted_user_id` 就是这个池名；（b）去 **Request Stats** 看这次请求的 Identity 是谁、Outcome 是不是 success（**只有成功才会刷新「最近使用」**）；（c）如果策略是 `sticky-affinity`，老会话会继续复用已有绑定，换个新会话再试 |

**不需要做的事**：不用重启任何容器，不用改 LiteLLM 配置，不用给客户端换 key。池的成员变化对客户端完全透明。

---

### 6.2 任务 B：某个账号被限流了怎么处理

**第一步永远是确认现状**：左侧 **Account Pools** → 目标池 **展开** → 看成员表的「状态」「连续失败」「冷却至」三列；同时开一个 **Request Stats** 页看 Failure 列。

然后按下表处置：

| 现象 | 判断 | 怎么做 |
|---|---|---|
| 某成员 `冷却中`，「冷却至」在几分钟内，其他成员 `可用` | 正常的自动故障转移 | **什么都不做。** 到点自动恢复。注意：触发冷却的那一次请求本身是失败返回给客户端的，切换从下一次请求开始生效 |
| 某成员 `冷却已到期`（蓝色） | 已经可以用了，只是状态字段还没刷新 | **什么都不做。** 也不要点「解除冷却」（会白白把它的「最近使用」刷到当前，反而更晚被选中） |
| 卡片头部显示 `可用 0 / N` | **全员冷却，正在出事**。客户端会收到带 `retryAfterSeconds` 的错误 | ① 看「冷却至」里最早的那个时间，判断还要等多久；② 如果确认是误伤（见下一行），逐个「解除冷却」；③ 如果是真的额度打满，只能加账号（走 [6.1](#61-任务-a新接入一个-copilot-账号并加进池)）或等 |
| Request Stats 里某账号一片 `failed / HTTP 429`，但成员表里它的「连续失败」还是 0、状态还是「可用」 | 见 [5.3 的源码判读](#故障转移行为三种策略都一样)：推理响应的 429 可能不会计入池的失败 | 别等冷却。直接把该成员 **移出** 池（先确认「可用 X / Y」里 X ≥ 2，别把最后一个可用成员摘了），限流窗口过去后再加回来 |
| 某成员反复冷却，但 Request Stats 里它的 Failure 不是 429，而是 5xx / 网络错误 | 可能是被偶发错误攒到失败阈值误伤的 | 点该行 **解除冷却**（记住 [5.3 ③](#-成员表格) 的三个副作用）；如果反复发生，考虑把「失败阈值」调大 |
| 某成员在 Proxy Accounts 页的 Copilot OAuth **不是 `valid`** | token 坏了，不是限流。这类请求返回 503 `oauth_not_ready`，且**不计入池的失败计数**，在 `least-loaded` 下会被反复优先选中 | **不要解除冷却。** 正确做法：把它从池里 **移出** → 用别的账号顶上 → 再单独修这个账号（重新导入 token；或 **Reauthorize Copilot**，但那条链路在本环境**未验证**） |
| 整个池都不该再接流量（比如客户要求立刻停某租户） | — | ⚠️ **不要点「停用池」**，那不是「拒绝服务」，见 [7.3](#73-停用池的连锁反应)。正确做法是在 **LiteLLM 侧禁用/删除对应的虚拟 key** |

**排查时要区分两层**：成员表的状态是**池层面**的判断；账号本身是否健康看 **Proxy Accounts** 页的 Copilot OAuth 列。两者不是一回事：token 有效的账号也可能因为限流被冷却，token 失效的账号在被请求前状态可能还是「可用」。

---

### 6.3 任务 C：查某段时间的用量与失败请求

**先接受三个限制**（否则会白找）：

1. Request Stats 页**没有时间范围选择器**，一次拉最近 1000 条，三个筛选框都是前端过滤。
2. **每个账号只保留最近 200 条**（本环境 `REQUEST_STATS_PER_ACCOUNT_LIMIT=200`），更早的在写入新记录时已被删除。
3. **表格里没有池这一列**，Identity 列是**实际成员账号**。要按池汇总必须走 API。

**界面上能做的：**

| 想查什么 | 怎么点 |
|---|---|
| 最近整体情况 | **Dashboard** → 看 `Recent tokens` 卡片（最近 100 条的合计，含 in / out / cache 拆分）。**这是采样不是账单** |
| 某个账号用了多少 | **Request Stats** → Identity 框输入 `<账号名>` → 表格自动过滤 → 看 Total 列。或者 **Proxy Accounts** → 勾中该账号 → **Details** → 弹窗下半部分是它**最近 20 条** |
| 某段时间 | **Request Stats** → 看 **Requested** 列自己圈范围。数据量大时用命令行（见下） |
| 只看失败 | **Request Stats** → Outcome 下拉选 **Failed** → 看 **Failure** 列（鼠标停上去看全文） |
| 失败的详细原因 | **Error Diagnostics** → 按 Time 找到对应记录（注意这一页 Identity 列是**池名**）→ **Details** 看预览 → 要完整内容点 **Download**。⚠️ 本环境记录**未脱敏** |
| 缓存命中效果 | **Request Stats** → 看 `Cache input`（命中读取）和 `Cache write`（写入）两列。跨账号命中也算在这里 |
| 某个池整体用了多少 | ❌ 界面做不到，见下 |
| 花了多少钱 | ❌ Console 里没有。去 LiteLLM 看虚拟 key 的 spend |

**命令行兜底**（按池汇总 / 按时间过滤）：

```bash
ssh -i <SSH 私钥路径> azureuser@<VM 公网 IP> \
  'curl -s -H "X-Internal-Token: <INTERNAL_API_TOKEN>" "http://127.0.0.1:<PROXY_PORT>/api/request-stats?limit=1000"' > stats.json
```

| 占位符 | 怎么取值 |
|---|---|
| `<SSH 私钥路径>` | 部署时生成的私钥，仓库里是 `pool_vm_key`（在仓库根目录） |
| `<VM 公网 IP>` | Azure 门户里 VM 的公网 IP，也就是 `<PUBLIC_HOST>` 去掉 `.nip.io` 的部分 |
| `<INTERNAL_API_TOKEN>` | VM 上 `/opt/ghcp-pool/.env`（本地对应 `.env.pool`）里的 `INTERNAL_API_TOKEN` |
| `<PROXY_PORT>` | 同一个文件里的 `PROXY_PORT`（本环境是 3000） |

期望输出：`stats.json` 是一个 **JSON 数组**（不是对象），每个元素含 `identity`、`poolId`、`requestedAt`、`path`、`model`、`success`、`failureReason`、`inputTokens`、`outputTokens`、`cacheInputTokens`、`cacheWriteTokens` 等字段。

失败时：

| 现象 | 怎么办 |
|---|---|
| `{"error":{"code":"internal_auth_failed",...}}` | 令牌不对。`/api/*` 这组接口**只校验 `X-Internal-Token` 一个头**，重新从 `.env` 里复制一遍（注意别把行尾空格也复制进去） |
| `Connection refused` | 端口不对，或 proxy 容器没起（`docker compose ps`） |
| SSH 直接超时 | 网卡 NSG / **子网 NSG** 把 22 端口挡了 |

按时间段统计（在你自己的机器上跑，需要 `jq`）：

```bash
jq '[.[] | select(.requestedAt >= "2026-09-01" and .requestedAt < "2026-09-08")]
    | {条数: length,
       输入: (map(.inputTokens // 0) | add),
       输出: (map(.outputTokens // 0) | add),
       失败: (map(select(.success == false)) | length)}' stats.json
```

期望输出：一个含四个数字的 JSON 对象。`requestedAt` 是 ISO 8601 字符串，所以直接按字符串比较即可。没装 jq 就 `sudo apt-get install -y jq`（Windows 可用 `winget install jqlang.jq`），或者用别的工具读这个 JSON 文件。

按池汇总：

```bash
jq 'group_by(.poolId // "无池") | map({池: (.[0].poolId // "无池"), 请求数: length,
      输入: (map(.inputTokens // 0) | add), 输出: (map(.outputTokens // 0) | add)})' stats.json
```

期望输出：每个池一行。**这是唯一能按池汇总的方式，界面上没有。**

---

## 7. 风险操作清单：点之前必须确认什么

### 7.1 会弹确认框的（还有一次后悔机会）

| 操作 | 位置 | 确认框文案（原文） | 点之前确认 |
|---|---|---|---|
| **删除池** | Account Pools → 池卡片右侧 | `删除账号池 "<池名>"？成员账号本身不会被删除。` | ⚠️ **正在用这个池名的客户端会立刻全部失败**（而且是走「未知 identity」路径，见 7.3）。先确认没有虚拟 key 的 `trusted_user_id` 还指向它。删除会连带清掉该池的成员关系和会话绑定，账号本身不受影响。成功 toast 是橙色的 `已删除账号池 <池名>` |
| **Delete selected**（账号） | Proxy Accounts → 蓝色操作条 | `Delete N selected Proxy account(s)? OAuth credentials and request stats will be deleted. SSO/GH users are not affected, and a future request may recreate the account and trigger login.` | ⚠️ **OAuth 凭据和请求统计一起删掉，不可恢复**。SSO/GH 用户不受影响 |
| **Delete Users**（SSO） | SSO Users → 批量条 | `Delete N selected local SSO user(s)? Copilot seats and provisioned GH login data will be deleted first when present.` | 会连带删 Copilot 席位和已开通的 GH 登录数据 |
| **Delete GH login** | SSO Users → 批量条 | `Delete provisioned GH login data for N selected user(s)? Copilot seats will be removed first.` | 本地 SSO 用户和 Proxy 数据保留 |
| **Remove seat** | SSO Users → 批量条 | `Remove Copilot seat(s) for N selected user(s)?` | 本环境这些操作大概率直接报错 |
| **Suspend** | SSO Users → 批量条 | `Suspend N selected GH login(s)?` | 同上 |
| **Clear all** | Error Diagnostics | `Clear all stored proxy error diagnostics? This cannot be undone.` | ⚠️ 排障现场一次性全没。**先把要留的记录 Download 下来** |
| **Cancel selected** | Login Tasks | `Cancel N selected login task(s)?` | 只对 pending/running 有效 |
| **Delete selected** | Login Tasks | `Delete N selected login task(s)? This cannot be undone.` | pending/running 的任务不能删 |

### 7.2 **不会**弹确认框、点了立即生效的（最危险的一类）

| 操作 | 位置 | 立即发生什么 |
|---|---|---|
| **移出**（成员） | Account Pools → 成员表格 | 成员立刻退出池，**同时删掉它在该池的全部会话绑定**。如果这是最后一个可用成员，**这个池马上不可用**。点之前先看卡片头部的「可用 X / Y」 |
| **解除冷却** | Account Pools → 成员表格 | 状态转 `active`；**「最近使用」被刷成当前时间**（默认策略下排到队尾）；**权重被重置为 1** |
| **选择策略**下拉框 | Account Pools → 配置区 | **选中即保存，立即对新请求生效**。从 `sticky-affinity` 切走 = 已有会话绑定不再被读取，会话会重新分配（缓存不受影响，因为缓存跨账号共享）。切回来时，未过期的旧绑定会重新生效 |
| **保存**（三个数字配置） | Account Pools → 配置区 | 立即生效。改小「失败阈值」会影响后续的失败判定（不会追溯已有计数） |
| **停用池 / 启用池** | Account Pools → 配置区 | 立即生效，后果见 7.3 |
| **Save and apply** | Settings → 两张运行时卡片 | 立即应用到新任务 / 新 SCIM 操作 |

### 7.3 「停用池」的连锁反应（单独讲，最容易踩）

徽章上写的是「已停用（**回落为普通身份**）」。这五个字的实际含义是：

> 池被停用后，`findPool()` 返回 undefined，Proxy 不再把这个名字当成池，而是把它当成一个**普通账号 identity** 去 `proxy_accounts` 里查。而池名在创建时就被强制**不能与任何账号重名**（否则 409）—— 所以停用后必然查不到对应账号，请求会走「未知 identity 初始化」路径：返回 **202 `account_initializing`**，并触发「按这个名字创建 SSO 用户 + 排一个登录任务」。

后果：

- 客户端不会得到干净的「服务不可用」，而是拿到 202 一直等不到结果。
- **Login Tasks 页会开始冒出任务**，SSO Users 页可能出现一个以池名命名的用户。本环境是导入 token 模式，这条自动开通链路走不通，任务会失败堆积。
- 这条链路是**按代码逐行推导得出的（`copilotAuthManager.getAuth` → `getAuthForAccount` → `beginIdentityInitialization`），未在云上实测**。但即使实际表现有出入，「停用池」也不是一个干净的停服开关。

**结论**：想临时停掉某个租户，**去 LiteLLM 禁用它的虚拟 key**，不要停用池。「停用池」只在你想临时冻结池配置、且确认此刻没有流量时才用。**用完记得启用回来**，并顺手去 SSO Users / Login Tasks 检查有没有留下垃圾用户和失败任务。

### 7.4 数据在哪、删了会怎样

| 数据 | 存放位置 | 删了的后果 |
|---|---|---|
| Console 管理员 | `console-data` 卷 → `/data/admins.json` | 回到 Initialize Console 状态，**任何人可抢先创建管理员** |
| 账号、账号池、成员、会话绑定、请求统计 | `proxy-data` 卷 → `/data/proxy.sqlite`（本环境 `STORAGE_DRIVER=sqlite`） | 整套池配置和账号凭据全丢，要重新导入 token 并重建池 |
| 错误诊断快照 | `proxy-data` 卷 → `/data/error-diagnostics` | 只丢排障现场 |
| SSO 用户 / SSO 运行时设置 | `sso-data` 卷（`sso.sqlite`） | SSO 用户没了，token 导入会开始报「用户不存在」 |
| Login 任务 / Login 运行时设置 | `login-data` 卷（`login.sqlite`） | 只丢任务历史 |
| 虚拟 key 和消费记录 | **LiteLLM 的 PostgreSQL，不在这些卷里** | Console 操作影响不到它 |

---

## 8. 界面上做不到、必须走命令行的事

| 需求 | 为什么界面做不到 | 怎么做 |
|---|---|---|
| **设置成员权重** | 成员表格只展示不可编辑；「加入池」按钮不传 weight，一律用默认 1 | 见下方命令。⚠️ 只在 `sticky-affinity` 策略下生效，且之后点「解除冷却」会重置回 1 |
| **把成员设为 `disabled`（永久停用但保留在池里）** | 界面只有「移出」，没有「停用成员」 | 加成员接口带 `"state":"disabled"` |
| **建池时直接指定策略/TTL/冷却/阈值** | 界面创建只用默认值 | 见下方 `POST /api/pools` |
| **按池汇总用量** | Request Stats 表格没有池列 | 见 [6.3](#63-任务-c查某段时间的用量与失败请求) 的 jq 命令 |
| **按时间范围查统计** | 页面没有时间筛选器 | 同上 |
| **查超过 200 条以前的历史** | 保留上限硬裁剪，写入时删旧 | ❌ 做不到，数据已被删除。需要长期留存就得另做外部归档（**本环境未做**） |
| **账号超过 100 个时给池加成员** | 页面只取前 100 个账号填下拉框 | 见下方命令 |
| **管理多个 Console 管理员** | 初始化只写一条记录，Settings 只能改当前管理员密码 | ❌ 不支持 |
| **重置忘记的管理员密码** | 无入口 | 见 [2.7](#27-忘记管理员密码)（**未实测**） |
| **看虚拟 key 的消费** | Console 不连 LiteLLM | 去 LiteLLM 侧查 |

**通用调用形式**（在 VM 上执行，或用 `ssh -i <SSH 私钥路径> azureuser@<VM 公网 IP> '<命令>'` 包起来）。`/api/*` 这组接口**只校验 `X-Internal-Token`**，不需要 `x-api-key`（`x-api-key` 是给推理接口用的；实测脚本里两个头都带过，多带一个无害）：

```bash
curl -s -H "X-Internal-Token: <INTERNAL_API_TOKEN>" \
     "http://127.0.0.1:<PROXY_PORT>/api/pools"
```

期望输出（形如）：

```
{"items":[{"poolId":"team-pool","strategy":"least-loaded","sessionTtlSeconds":1800,"cooldownSeconds":300,"failureThreshold":3,"enabled":true,"members":[...],"activeMembers":2,"totalMembers":2}],"total":1}
```

失败时：401 `internal_auth_failed` → 令牌不对；`Connection refused` → 端口/容器问题。

**建池并一次性指定参数：**

```bash
curl -s -X POST \
  -H "X-Internal-Token: <INTERNAL_API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"poolId":"<池名>","strategy":"least-loaded","sessionTtlSeconds":1800,"cooldownSeconds":300,"failureThreshold":3}' \
  "http://127.0.0.1:<PROXY_PORT>/api/pools"
```

期望：HTTP 201 + 池详情。失败：400 `pool_id_invalid` / 400 `pool_strategy_invalid` / 409 `pool_id_conflicts_with_account`。

**设置权重 / 给池加成员**（同一个接口，已存在的成员会被更新）：

```bash
curl -s -X POST \
  -H "X-Internal-Token: <INTERNAL_API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"identity":"<账号名>","weight":8}' \
  "http://127.0.0.1:<PROXY_PORT>/api/pools/<池名>/members"
```

期望输出：HTTP 201，返回体里 `"weight": 8`。
失败时：`account_not_found` → 该账号还没导入，先走 [6.1](#61-任务-a新接入一个-copilot-账号并加进池)；`pool_not_found` → 池名拼错；`member_cannot_be_pool` → 你把池名自己填进去了。
⚠️ `weight` 必须是正整数，填 0 或负数会被**静默忽略**（接口照样 201，但 weight 保持原值）。改完回界面刷新确认，并记住**任何一次「解除冷却」都会把它打回 1**。

**手动解除某成员冷却（等价于界面按钮）：**

```bash
curl -s -X POST -H "X-Internal-Token: <INTERNAL_API_TOKEN>" \
  "http://127.0.0.1:<PROXY_PORT>/api/pools/<池名>/members/<账号名>/resume"
```

期望：HTTP 200 + 池详情。副作用和界面按钮完全一样（含权重重置为 1）。

**批量导入 token（等价于界面弹窗）：**

```bash
curl -s -X POST \
  -H "X-Internal-Token: <INTERNAL_API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"csvText":"name,copilotOauthToken\n<账号名>,<token>"}' \
  "http://127.0.0.1:<PROXY_PORT>/api/accounts/copilot-oauth-token/import"
```

期望：返回 `{"batchId":...,"summary":{"total":1,"success":1,"failed":0},"rows":[...]}`。

> ⚠️ 仓库里的 `provision.sh` / `provision-pool.sh` 里写的导入路径与源码路由**不一致**（脚本用的是 `/api/accounts/import-copilot-oauth-tokens`，源码里注册的是 `/api/accounts/copilot-oauth-token/import`）。**以实际返回为准**：拿到 404 就换成上面这个路径。这一点**需现场确认**，也建议顺手把脚本改掉。

> Windows 本地执行时注意：PowerShell 里内联 JSON 要用**单引号**包裹，用双引号加 `\"` 转义会被吃掉；编辑上传到 Linux 的脚本注意 CRLF。

---

## 9. 报错速查表

| 你看到的 | 在哪 | 含义 / 怎么办 |
|---|---|---|
| 页面整个打不开、转圈 | 浏览器 | 按顺序查：网卡 NSG → **子网 NSG** → VM 电源 → 容器状态。**子网 NSG 这层最容易漏**（订阅策略会新建一个零规则的子网 NSG 挂到 VNet 上，而且新建资源天生没有 `SecurityControl=Ignore` 标签，打标签挡不住这种） |
| 页面停在 `Loading console...` | 登录前 | Console 容器起来了但 `/api/console/setup` 没响应；如果上方还有红色错误条，那就是具体错误消息。看 `docker compose logs console` |
| 顶部红条 `username and password are required.` | Initialize / Login | 用户名或密码框是空的 |
| 顶部红条 `Console is already initialized.` | Initialize | 你和别人同时在初始化，对方先成功了。**立刻确认是谁做的** |
| 某页红色错误条 | 任意页 | 先去 **Diagnostics** 点 Run checks，定位是哪个下游服务断了 |
| Diagnostics 里任一卡片 `Failed` + `internal_auth_failed` | Diagnostics | Console 和目标服务的 `INTERNAL_API_TOKEN` 不一致（改过 `.env` 但只重启了一半容器） |
| Diagnostics 里 SSO users = Failed | Diagnostics | 大概率 SSO 容器 CrashLoop。**最常见原因：缺 SAML 证书** `/certs/idp-cert.pem`、`idp-key.pem`。导入 token 模式下自签证书就够 |
| 导入 token 时 `SSO user "<name>" was not found...` | Proxy Accounts | 先去 SSO Users 建用户，**名字用 SSO 列表里显示的那个（小写）** |
| 导入 token 时整批只回一条 `CSV header must be exactly: name,copilotOauthToken` | Proxy Accounts | 表头被改过。必须精确是这两个词，大小写敏感 |
| 导入 token 时 `Expected two columns` | Proxy Accounts | 该行列数不对；token 里若含逗号要用双引号包起来 |
| 创建池报 `pool_id_invalid` | Account Pools | 名字含中文/空格/非法字符，或首字符不是字母数字，或超过 128 字符 |
| 创建池报 `pool_id_conflicts_with_account` | Account Pools | 已经有同名账号了，换个池名 |
| 加成员报 `account_not_found` | Account Pools | 该账号还没导入（或大小写不一致） |
| 加成员报 `member_cannot_be_pool` | Account Pools | 你想把池自己加成成员 |
| 卡片显示 `可用 0 / N` | Account Pools | 全员冷却。按 [6.2](#62-任务-b某个账号被限流了怎么处理) 处置 |
| 客户端收到带 `retryAfterSeconds` 的错误 | 客户端 | 就是上面这条（`PoolAllCoolingError`） |
| 客户端 503 `oauth_not_ready` | 客户端 | 请求落到了一个 token 不是 `valid` 的成员。去 Proxy Accounts 查该账号，把它**移出**池 |
| 客户端一直收到 202 `account_initializing` / 请求悬停 | 客户端 | 检查对应的池是不是被「停用」了，或者虚拟 key 里的 `trusted_user_id` 拼错成了一个不存在的名字，见 [7.3](#73-停用池的连锁反应) |
| 客户端 401 | 客户端 | 没带 key。LiteLLM 强制要虚拟 key |
| 客户端 403 | 客户端 | 用 master key 直接推理会被 hook 拒（实测行为，符合预期）。必须用虚拟 key |
| Request Stats 里一片 `HTTP 429` | Request Stats | 上游限流。注意成员的「连续失败」可能仍是 0，见 [5.3 的源码判读](#故障转移行为三种策略都一样) |
| 请求返回 `stop_reason=refusal`、`category=reasoning_extraction` | 测试脚本 | Anthropic 误判合成文本。**重复段落、`Rule N: ... cite internal reference document REF-XXXX` 这类模板文本会触发**。写测试用例要用内容各异的自然文本 |
| Settings 保存报 `... changed in another session. The latest values were reloaded.` | Settings | 别人先改了，页面已自动重载最新值，**你的输入被覆盖了**，重填再存 |
| 缓存一直不命中 | Request Stats | 客户端必须显式带 `cache_control: {"type":"ephemeral"}`，且内容要超过约 1024 token。Claude Code 自带这个字段。**换账号不是原因** —— 缓存跨账号共享是实测结论 |