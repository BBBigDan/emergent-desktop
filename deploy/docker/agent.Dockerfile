# agent：粒子场的服务端。零 npm 依赖，只要 node + 这份代码。
FROM node:22-alpine

# persona 说时间要给人话（"昨天 17:14"），用 Intl 就够；但 pod 里 `date` 这类
# 命令要跟 TZ 一致，差那 3MB 不值得为它留个"怎么日志时间是 UTC"的疑问。
RUN apk add --no-cache tzdata

WORKDIR /app

# 代码。`.dockerignore` 已经把 .env / .kube / sessions / usage / memory 挡在外面 ——
# 镜像要推到公开的 ghcr.io，凭据进镜像等于公开发布。
COPY agent/ /app/agent/

# prompt.mjs 里有 `import { brief } from '../shell/src/timing.js'` ——
# 那张常数表一份代码三个身份（页面动画 / 提示词里的规范 / Pacer），
# 所以壳层和 agent 必须在同一个父目录下，不能只复制 timing.js 一份过来。
COPY shell/ /app/shell/

# 静态目录：容器里由 nginx 服务（root /www），这里只是让 agent 自带的静态服务
# 在没有 nginx 时也能跑起来（`?dev=1` 那条路）。同源同内容，不会漂移。
ENV WEB_ROOT=/app/shell

# 两个运行时要写目录，清单里会挂 hostPath 盖掉（会话存档 + token 日账本，
# 属于"跨重启该留下的数据"，不该跟着镜像版本来回变）。这里先建出来，
# 保证单独跑这个镜像时也能起来。
RUN mkdir -p /app/agent/sessions /app/agent/usage

EXPOSE 8788

# 不用 shell 包一层：node 收到 SIGTERM 才会走完 idle 落盘。
# （`node xxx.mjs` 形式下 node 就是 PID 1，信号直达。）
CMD ["node", "/app/agent/server.mjs"]
