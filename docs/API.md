# 口袋助手 开放 API 接口文档

供工具端（客户端）与前台页面调用。基础地址：`https://<你的域名>`。

## 目录

- [通用约定](#通用约定)
- [认证与令牌](#认证与令牌)
- [版本与同步](#版本与同步)
- [每日签到](#每日签到)
- [文件传输](#文件传输)
- [游戏账号](#游戏账号)
- [点数与计费](#点数与计费)
- [错误码约定](#错误码约定)

---

## 通用约定

### 请求格式

- 请求体为 `application/json`（文件上传另支持 `multipart/form-data`）。
- 时间戳均为服务器时区 `YYYY-MM-DD HH:mm:ss` 或 `YYYY-MM-DD`。

### 鉴权（必须）

除注册/登录外，所有接口需携带会员 API 令牌（登录后获取，48 位十六进制）：

```
Authorization: Bearer <token>
```

无法设置请求头的场景（如工具直接下载）可用查询参数替代：`?token=<token>`。

令牌可调用 `POST /api/token?regen=1` 重新生成；退出登录会自动重置。

### 响应签名（防篡改/防伪造）

除 401 未认证外，所有需要鉴权的 JSON 响应都带以下响应头：

| 响应头 | 说明 |
|---|---|
| `X-Timestamp` | 服务器毫秒时间戳 |
| `X-Nonce` | 8 字节随机十六进制 |
| `X-Sign` | 签名 |
| `X-Sign-Alg` | 固定 `HMAC-SHA256` |

校验算法（工具端用本地保存的 token 重算）：

```
X-Sign = HMAC_SHA256(key = token, message = X-Timestamp + "." + X-Nonce + "." + 响应体原文)
```

- 响应体原文指未经 JSON 重新序列化的原始字节。
- 建议：时间戳与本地时间偏差超过 5 分钟则拒绝该响应；token 不匹配时签名必然对不上，可判定为伪造。

> 二进制下载接口（文件下载）无法对响应体整体签名，改用 `X-File-Sha256` 头做完整性校验。

### 统一响应结构

```json
{ "success": true,  "...": "业务字段" }
{ "success": false, "message": "错误原因", "code": "可选错误码" }
```

---

## 认证与令牌

### 注册 `POST /api/register`

```json
请求：{ "username": "abc", "password": "至少8位", "inviteCode": "选填" }
响应：{ "success": true, "message": "注册成功", "points": 600, "inviteCode": null }
```

### 登录 `POST /api/login`

```json
请求：{ "username": "abc", "password": "..." }
响应：{ "success": true, "token": "48位令牌", "user": { "id": 1, "username": "abc", "plan": "高级版", "points": 600, "status": "正常" } }
```

### 获取当前用户 `GET /api/me`

```json
响应：{ "success": true, "loggedIn": true, "user": { "id": 1, "username": "abc", "plan": "高级版", "points": 123.45, "status": "正常" } }
```

### 退出登录 `POST /api/login` → `POST /api/logout`

自动重置 API 令牌，原令牌立即失效。

### 获取/重置令牌 `ALL /api/token`

- 默认返回现有令牌（没有则生成）：`{ "success": true, "token": "..." }`
- `?regen=1` 或请求体 `{ "regen": true }`：强制重置。

---

## 版本与同步

工具端据此判断本地版本是否为最新，以及需要下载哪些资源包 / 安装包。两类资源：

- **资源包（客户端资源）**：含桌面 exe，由后台「客户端资源」页维护，对外版本号为 `client_version`（后台设置的版本字符串）。
- **安装包（版本安装包）**：脚本/压缩包等，每个独立版本号（`version`）与内容摘要（`sha256`）。

所有时间字段（`updatedAt` / `createdAt` / `serverTime`）均为 UTC：`updatedAt`/`createdAt` 形如 `YYYY-MM-DD HH:MM:SS`（服务器 D1 存储时间）；`serverTime` 为 ISO8601。二进制下载接口通过响应头 `X-File-Sha256` 做完整性校验。

### 查询客户端版本（公开） `GET /api/version`

无需鉴权，供下载页与工具端取当前最新客户端版本号与 exe 资源清单。

```json
响应：
{
  "success": true,
  "version": "1.2.5",
  "updatedAt": "2026-11-05 12:34:56",
  "resources": [
    { "name": "koudai.exe", "url": "/api/client/resource/koudai.exe",
      "sha256": "<64位>", "size": 12345678, "updatedAt": "2026-11-05 12:34:56" }
  ]
}
```

`resources` 仅含 `.exe` 资源；`updatedAt` 为各资源独立的上传时间。

### 版本对比（公开） `GET /api/version/check?current=<本地版本号>`

直接告诉你本地版本与服务器是否一致。

```json
响应：
{
  "success": true,
  "current": "1.2.3",
  "latest": "1.2.5",
  "upToDate": false,      // 与服务器最新版是否一致
  "hasNewer": true,       // 服务器是否有更新版本
  "resources": [ { "name": "koudai.exe", "sha256": "...", "size": 12345678,
                   "updatedAt": "2026-11-05 12:34:56", "url": "/api/client/resource/koudai.exe" } ]
}
```

- `upToDate = (current 非空 且 等于 latest)`。
- `hasNewer` 按语义化版本号比较（如 `1.2.3 < 1.2.5` 为真）。
- `current` 为空时 `upToDate`/`hasNewer` 均为 false，仅返回 `latest` 供工具获知目标版本。

### 统一同步检查（需鉴权） `GET /api/sync`

一次性返回资源包清单（含上传时间）与安装包清单（含上传时间与上传人），工具端据此逐项比对 `sha256` 判断是否需要更新。

```json
响应：
{
  "success": true,
  "serverTime": "2026-11-05T12:34:56.000Z",
  "clientVersion": "1.2.5",
  "resources": [
    { "name": "koudai.exe", "sha256": "...", "size": 12345678,
      "updatedAt": "2026-11-05 12:34:56", "url": "/api/client/resource/koudai.exe" }
  ],
  "packages": [
    { "key": "p-abc", "name": "脚本包.zip", "version": "2.1",
      "sha256": "...", "size": 99999, "createdAt": "2026-11-04 09:00:00",
      "uploadedBy": "admin", "url": "/pkg/p-abc" }
  ]
}
```

鉴权同安装包列表（登录会话或 `Authorization: Bearer <token>`）；未携带令牌返回 401。

### 安装包列表（需鉴权） `GET /api/packages`

```json
响应：{ "success": true, "packages": [ { "key": "p-abc", "name": "脚本包.zip",
         "version": "2.1", "size": 99999, "sha256": "...",
         "createdAt": "2026-11-04 09:00:00", "url": "/pkg/p-abc" } ] }
```

### 下载资源包二进制 `GET /api/client/resource/:name`

返回 exe 二进制体。响应头：

| 响应头 | 说明 |
|---|---|
| `X-File-Name` | 文件名（URL 编码） |
| `X-File-Size` | 字节数 |
| `X-File-Sha256` | 内容 SHA-256，**下载后必须校验** |

不存在：HTTP 404。

### 下载安装包二进制 `GET /pkg/:id`（需鉴权）

`id` 即安装包 `key`。返回二进制体，响应头同资源包（`X-File-Sha256` 校验）。

---

## 每日签到

前台 `/checkin` 页面与工具端共用同一套接口。

### 查询签到状态 `GET /api/checkin`

```json
响应：
{
  "success": true,
  "enabled": true,          // 功能开关（后台可关闭）
  "rewards": [5, 10, 15],   // 完整奖励序列（点数数组）
  "cycleLength": 30,        // 周期长度（天）
  "today": "2026-11-04",
  "todayChecked": false,    // 今日是否已签
  "totalDays": 12,          // 累计签到天数
  "cycleDay": 13,           // 当前周期第几天（已签=今天，未签=下次签到所在天）
  "todayReward": 65,        // 本次签到可得点数
  "lastReward": null,       // 今日已签时的实得点数
  "nextReward": 70,         // 下次签到可得点数
  "lastCheckinDay": "2026-11-03"
}
```

> 未开启时 `enabled: false`，其余字段仍返回，`todayReward` 等无效。

### 执行签到 `POST /api/checkin`

```json
成功：{ "success": true, "message": "签到成功，获得 65 点数", "reward": 65, "cycleDay": 13, "day": "2026-11-04",
       "totalDays": 13, "remainingPoints": 123.45, "nextReward": 70 }
今日已签（HTTP 400）：{ "success": false, "code": "ALREADY", "message": "今日已签到，明天再来吧" }
功能未开启（HTTP 403）：{ "success": false, "code": "DISABLED", "message": "签到功能未开启" }
```

规则说明：

- 奖励按周期逐日递增（默认第 1 天 5 点、每天 +5，第 30 天 150 点），由后台「签到配置」页可整体修改。
- 断签不打断顺序：按累计签到天数在一个周期内顺延，周期结束后重新从第 1 天开始。
- 每日仅可签一次（服务器日期为准）；奖励点数直接计入账户余额。

---

## 文件传输

工具端与云端同步文件。单文件上限 **20MB**，按用户隔离，仅能访问本人文件。

### 上传 `POST /api/files/upload`

方式一：`multipart/form-data`，文件放 `file` 字段。

方式二：`application/json`：

```json
请求：{ "name": "config.json", "mime": "application/json", "dataBase64": "<文件内容 Base64>" }
响应：{ "success": true, "message": "上传成功",
       "file": { "id": "f-a1b2...", "name": "config.json", "size": 1024,
                 "sha256": "<64位内容摘要>", "mime": "application/json", "chunks": 1 } }
过大（HTTP 413）：{ "success": false, "message": "文件过大，单文件上限 20MB" }
```

### 文件列表 `GET /api/files?page=1&pageSize=50`

```json
响应：{ "success": true, "total": 3, "page": 1, "pageSize": 50,
       "files": [ { "id": "f-a1b2...", "name": "config.json", "size": 1024,
                    "sha256": "...", "mime": "application/json", "chunks": 1,
                    "created_at": "2026-11-04 10:00:00" } ] }
```

### 下载 `GET /api/files/:id`

返回二进制文件体。响应头：

| 响应头 | 说明 |
|---|---|
| `X-File-Id` / `X-File-Name` | 文件 ID / 文件名（URL 编码） |
| `X-File-Size` | 字节数 |
| `X-File-Sha256` | 内容 SHA-256，**下载后必须校验** |
| `Content-Disposition` | `attachment; filename*=UTF-8''<URL编码文件名>` |

不存在或非本人文件：HTTP 404。

### 删除 `DELETE /api/files/:id`

```json
成功：{ "success": true, "message": "删除成功" }
不存在（HTTP 404）：{ "success": false, "message": "文件不存在" }
```

---

## 游戏账号

### 列表 `GET /api/accounts`

- 带用户会话/token 时：`GET /api/accounts?userId=<id>` 返回该用户账号、积分、默认账号、工具运行状态与费率。
- 不带参数返回全部账号（兼容旧版，逐步弃用）。

### 创建 `POST /api/accounts`

```json
请求：{ "userId": 1, "name": "角色名", "uid": "", "serverId": "", "profileDir": "", "lastLoginAt": 0,
       "serverInfoToken": "", "tokenExpireAt": 0, "avatar": "", "qqAccessToken": "", "qqOpenid": "", "status": "正常" }
响应：{ "success": true, "id": "acc-1", "firstBind": true, "benefitEligible": true, "tracked": true, "message": "创建成功" }
```

同一 `(uid, serverId)` 重复绑定不发放首绑奖励（`firstBind: false`）。

### 更新 `PUT /api/accounts/:id`

`id` 支持数字主键或 `acc_id`。请求体传需要更新的字段（同创建），忽略未提供字段。

### 删除 `DELETE /api/accounts/:id`

删除账号；若是该用户默认账号，自动切换为剩余第一个。

---

## 点数与计费

### 查询套餐开关 `GET /api/points/plan` / 设置 `POST /api/points/plan`

```json
{ "success": true, "enabled": true }
```

### 使用扣费 `POST /api/points/deduct`（需鉴权）

```json
请求：{ "accountId": "acc-1", "minutes": 30 }          // 按时长，按每小时费率折算
或    { "accountId": "acc-1", "points": 2.5 }          // 直接指定点数
响应：{ "success": true, "userId": 1, "accountId": "acc-1",
       "deducted": 0.5, "remainingPoints": 122.95, "insufficient": false }
```

账号不属于该用户：`code: "ACCOUNT_MISMATCH"`。余额不足时扣到 0 并置 `insufficient: true`。

### 工具启停 `POST /api/points/start` / `POST /api/points/stop`（需鉴权）

启动/停止云端托管计费，返回当前费率与每日最低消费说明。

### 流水查询 `GET /api/points/records?type=&page=&pageSize=`（需鉴权）

- `type`：`usage`（使用扣费）/ `daily_min`（每日最低）/ `checkin`（签到奖励），可省略查全部。
- 响应：`{ "success": true, "total": n, "records": [ { "amount", "added_points", "deducted_points", "remaining_points", "type", "day" } ] }`

### 每日结算 `POST /api/points/settle`

```json
请求：{ "day": "2026-11-03", "userId": 1 }   // 均可省略，默认昨天、全部用户
响应：{ "success": true, "day": "...", "dailyMin": 12, "processed": n, "totalCharged": x, "details": [...] }
```

定时任务每天北京时间 00:00 自动结算前一日。

---

## 错误码约定

| 场景 | HTTP | code |
|---|---|---|
| 未提供令牌 | 401 | — |
| 令牌无效/已失效 | 401 | — |
| 账号已过期 | 403 | — |
| 签到功能未开启 | 403 | `DISABLED` |
| 今日已签到 | 400 | `ALREADY` |
| 账号归属不符 | 200 | `ACCOUNT_MISMATCH` |
| 文件过大 | 413 | — |
| 资源不存在 | 404 | — |
| 服务器内部错误 | 500 | — |

> 服务器不会返回内部堆栈；所有 500 统一为「服务器错误」。
