# 记忆侧车：Python 3.11 + axolotl_rs（Rust 图引擎的 PyO3 绑定）。
#
# 两个不能动的约束：
#   1. **必须是 3.11。** wheel 是 cp311-cp311，升 3.12 就没有 ABI 可用了，
#      而重建 wheel 要上游 Rust 源码 + 两个补丁（deploy/axolotl-*.patch）。
#   2. **必须是 glibc。** wheel 是 manylinux_2_34，alpine（musl）装不上 ——
#      别看着 slim 比 alpine 大就换过去。
FROM python:3.11-slim

WORKDIR /app

# wheel 直接 vendor 在仓库里（465KB），不打网络请求：镜像构建不该依赖
# "上游那个 release 还在不在"。它是从 axolotl 源码 + 两个补丁编出来的，
# 见 deploy/wheels/README.md。
COPY deploy/wheels/axolotl_rs-0.1.0-cp311-cp311-manylinux_2_34_x86_64.whl /tmp/
RUN pip install --no-cache-dir /tmp/axolotl_rs-*.whl && rm -f /tmp/axolotl_rs-*.whl

# 侧车本体（纯标准库，除 axolotl_rs 外无依赖）
COPY agent/memsvc/ /app/agent/memsvc/

# 内建 http.server，日志要立刻出来，否则排障时看的是上一轮的输出
ENV PYTHONUNBUFFERED=1

EXPOSE 7801

CMD ["python3", "/app/agent/memsvc/server.py"]
