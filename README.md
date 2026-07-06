# 算法助手

一个轻量、可自部署的多用户聊天系统，前端为原生页面，后端基于 Fastify，数据存储使用 PostgreSQL，并可选使用 Redis 做缓存加速。

## 功能概览

- 邮箱注册/登录，JWT 鉴权
- 多会话管理（新建、切换、归档）
- 支持 OpenAI 兼容接口与 Responses API 格式
- 管理员后台（用户、模型提供商、全局设置、统计）
- 技能（系统提示词模板）管理
- 代码审查页面
- 图片上传与静态资源服务

## 技术栈

- Node.js + Fastify
- PostgreSQL
- Redis（可选）
- 原生 HTML/CSS/JS 前端

## 目录结构

- server.js：服务入口
- db/schema.sql：数据库初始化脚本
- db/index.js：数据库连接与迁移
- db/cache.js：Redis + 内存降级缓存
- routes/：后端路由
- public/：前端静态页面与资源
- docker-compose.yml：本地 PostgreSQL 容器配置

## 环境要求

- Node.js 18+（推荐 20 LTS）
- PostgreSQL 16+（或使用项目内 docker compose）
- Redis（可选，未配置时自动降级内存缓存）

## 环境变量

复制示例配置：

```bash
cp .env.example .env
```

常用变量说明：

| 变量名 | 是否必填 | 默认值 | 说明 |
|---|---|---|---|
| PORT | 否 | 3131 | 服务监听端口 |
| DATABASE_URL | 是 | - | PostgreSQL 连接串 |
| JWT_SECRET | 强烈建议设置 | change-me-dev-secret | JWT 签名密钥 |
| JWT_EXPIRES_IN | 否 | 7d | Token 过期时间 |
| API_KEY_ENCRYPTION_SECRET | 强烈建议设置 | change-me-32-byte-secret | 上游 API Key 加密密钥 |
| DEFAULT_BASE_URL | 否 | http://localhost:11434 | 默认上游基地址（用于初始值） |
| ADMIN_EMAIL | 否 | 空 | 与该邮箱匹配的用户将自动获得管理员权限 |
| REDIS_URL | 否 | redis://127.0.0.1:6379 | Redis 地址 |
| REDIS_KEY_PREFIX | 否 | lite-chat | Redis Key 前缀 |
| REDIS_READ_TIMEOUT_MS | 否 | 30 | Redis 读取超时（毫秒） |

## 快速启动（本地开发）

### 1. 安装依赖

```bash
npm ci
```

### 2. 启动 PostgreSQL

你有两种方式：

方式 A：本机已安装 PostgreSQL，手动创建数据库并执行 schema。  
方式 B：直接使用仓库内 compose（推荐）：

```bash
docker compose up -d postgres
```

说明：此 compose 仅启动 PostgreSQL，并自动挂载 db/schema.sql 进行初始化。

### 3. 配置环境变量

```bash
cp .env.example .env
```

如果使用 compose 默认数据库，通常无需改 DATABASE_URL。  
请务必在 .env 中修改以下密钥：

- JWT_SECRET
- API_KEY_ENCRYPTION_SECRET

### 4. 启动服务

开发模式：

```bash
npm run dev
```

生产模式：

```bash
npm start
```

### 5. 访问应用

- 聊天首页：http://localhost:3131/
- 管理后台：http://localhost:3131/admin.html
- 代码审查：http://localhost:3131/code-review.html

## 部署流程（生产推荐）

推荐生产架构：应用进程（Node.js）与 PostgreSQL、Redis 分离部署。  
即：PostgreSQL 与 Redis 作为独立容器常驻运行，应用通过环境变量连接它们。

### 步骤 1：准备服务器

- 安装 Node.js 20 LTS
- 安装 Docker 与 Docker Compose
- 开放应用端口（例如 3131）或仅对内网开放，前置 Nginx

### 步骤 2：拉取代码并安装依赖

```bash
git clone <your-repo-url> lite-chat
cd lite-chat
npm ci --omit=dev
```

### 步骤 3：启动 PostgreSQL 与 Redis（独立容器）

```bash
docker compose up -d postgres
```

如果你的 compose 文件未定义 redis，可以独立启动：

```bash
docker run -d \
   --name lite-chat-redis \
   --restart unless-stopped \
   -p 127.0.0.1:6379:6379 \
   redis:latest
```

检查容器状态：

```bash
docker compose ps
docker compose logs -f postgres
docker ps --filter "name=lite-chat-redis"
```

### 步骤 4：配置生产环境变量

```bash
cp .env.example .env
```

至少修改：

- PORT（如 3131）
- DATABASE_URL（按实际 PostgreSQL 地址）
- JWT_SECRET（高强度随机字符串）
- API_KEY_ENCRYPTION_SECRET（高强度随机字符串）
- ADMIN_EMAIL（你的管理员邮箱）
- REDIS_URL（建议启用，例如 redis://127.0.0.1:6379）

### 步骤 5：启动应用

可选 A：pm2

```bash
npm i -g pm2
pm2 start server.js --name lite-chat
pm2 save
pm2 startup
```

可选 B：systemd（示例）

创建 /etc/systemd/system/lite-chat.service：

```ini
[Unit]
Description=算法助手 Service
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/lite-chat
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production
EnvironmentFile=/opt/lite-chat/.env
User=www-data
Group=www-data

[Install]
WantedBy=multi-user.target
```

然后执行：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now lite-chat
sudo systemctl status lite-chat
```

### 步骤 6：反向代理（建议）

建议使用 Nginx/Caddy 终止 HTTPS，并将流量转发到 127.0.0.1:3131。

注意：如果启用反代，请正确传递以下头：

- X-Forwarded-Proto
- X-Forwarded-Host

### 线上参考拓扑（与你当前环境一致）

可参考如下常驻容器形态：

- `lite-chat-postgres`：`127.0.0.1:5432->5432/tcp`
- `lite-chat-redis`：`127.0.0.1:6379->6379/tcp`

应用服务通过 `.env` 连接：

- `DATABASE_URL=postgres://lite_chat:<password>@127.0.0.1:5432/lite_chat`
- `REDIS_URL=redis://127.0.0.1:6379`

## 管理员初始化

设置 ADMIN_EMAIL 后：

1. 使用该邮箱注册账号（或首次登录）。
2. 系统会自动将该账号标记为管理员。
3. 打开 admin.html 进入管理后台。

## 常用命令

```bash
# 本地开发
npm run dev

# 生产运行
npm start

# 启动数据库
docker compose up -d postgres

# 停止数据库
docker compose down

# 查看数据库日志
docker compose logs -f postgres
```

## 数据与备份

- PostgreSQL 数据卷：docker compose 使用命名卷 postgres_data
- Redis 建议使用 appendonly 或快照策略，并按业务要求做持久化
- 备份建议：定期执行 pg_dump，并将备份文件同步到异地存储
- 上传文件目录：uploads/

示例备份（容器内执行）：

```bash
docker exec -t lite-chat-postgres pg_dump -U lite_chat -d lite_chat > lite_chat_$(date +%F).sql
```

## 故障排查

1. 启动失败且提示数据库连接错误  
   检查 DATABASE_URL、PostgreSQL 是否就绪、端口是否被占用。

2. 登录后提示权限异常  
   检查 JWT_SECRET 是否在重启前后发生变化。

3. 提供商请求失败（模型列表/对话）  
   在管理后台确认 base_url、api_key、api_format 是否正确。

4. Redis 不可用  
   服务会自动降级到内存缓存。请优先检查 `REDIS_URL`、`lite-chat-redis` 容器状态与端口映射。

## 安全建议

- 生产环境必须更换默认密钥（JWT_SECRET、API_KEY_ENCRYPTION_SECRET）
- 建议仅通过 HTTPS 对外暴露
- 管理后台建议加上额外网络层访问控制
- 定期更新依赖并进行安全审计

## License

如需开源发布，请补充 LICENSE 文件并在此处声明协议。
