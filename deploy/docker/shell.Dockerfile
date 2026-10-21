# 壳层：一张静态站 + 一层反代。
#
# 为什么不用原来那个 `beclab/docker-nginx-headers-more`：查过配置，emergent-desktop.conf
# 里只有 `map` / `add_header` / `proxy_*`，一个 headers-more 指令都没用到。
# 用官方的 nginx:alpine 少一个来路不明的第三方镜像，也少 300MB。
FROM nginx:1.27-alpine

# 站点根：install.sh/清单里 nginx 的 root 就是 /www
COPY shell/ /www/

# 基础镜像自带的 default.conf 会再起一个 80 端口的 server（root 指向它自己的欢迎页）。
# 我们的站点在 91 上（ConfMap 挂进来），这里把这个多余的 server 去掉：
# 只有一个 server 块时，请求不会意外落到欢迎页上。
RUN rm -f /etc/nginx/conf.d/default.conf

# 91 是 Olares 里桌面入口约定的端口（edge-desktop 的 targetPort 就是它）
EXPOSE 91

# 只检查 nginx 配置能起来。真正的就绪判断交给 pod 的 readinessProbe（tcp 91）——
# 容器里的 HEALTHCHECK 在 k8s 下不生效，写了只会让人以为它在起作用。
CMD ["nginx", "-g", "daemon off;"]
