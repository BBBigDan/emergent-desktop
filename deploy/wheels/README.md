# vendor 的 wheel：axolotl_rs

```
axolotl_rs-0.1.0-cp311-cp311-manylinux_2_34_x86_64.whl   465 KB
```

## 为什么放在仓库里

它是 `memory` 镜像里唯一的非标准库依赖：`agent/memsvc/server.py` 用它把记忆写进 `.axeb`。
两条理由：

1. **上游没有发版。** 这个 wheel 是从 axolotl 的 Rust 源码编出来的，源码不在这个仓库里，
   也不是 `pip install axolotl-rs` 就能拿到的 —— 要打两个补丁（`deploy/axolotl-linux.patch`、
   `deploy/axolotl-py-bindings.patch`）才能在 Linux 上过编译、才能全量枚举顶点和边。
2. **构建不该依赖网络。** 如果镜像构建时去某个 release 地址下载，那个地址哪天没了，
   这套东西就再也打不出镜像了。465 KB 换一个"永远能重建"，值。

## 两个硬约束（换基础镜像前先读这条）

- **cp311** → `FROM python:3.11-slim`。升到 3.12 就没有这个 ABI 的 wheel 了。
- **manylinux_2_34** → 必须 glibc。`python:3.11-alpine` 是 musl，**装不上**。

## 怎么重建

在 Linux x86_64（或任何能跑 cargo + maturin 的 x86_64 机器）上：

```bash
git clone <axolotl 源码> && cd axolotl
git apply /path/to/deploy/axolotl-linux.patch        # Cargo.toml 两处 + lib.rs 六行 cfg
git apply /path/to/deploy/axolotl-py-bindings.patch  # 补 vertices() / edges()
cargo build --release                                # 1m24s
maturin build --features python-bindings             # → target/wheels/*.whl
```

补丁为什么这么改、Linux 上少了什么（4 个实验性增量类型，Python API 一个不少），
以及冒烟测试的实数，见 `docs/agent-可行性论证.md` §6.2。

> 冒烟测试要重跑：`python3 -c "import axolotl_rs; print(dir(axolotl_rs))"` 之后
> 建 2000 节点 / 2285 边，`pagerank / bfs / louvain / save + open` 各来一遍。
> 这四样过了才算这个 wheel 能用 —— 单看"装上没报错"说明不了什么。
