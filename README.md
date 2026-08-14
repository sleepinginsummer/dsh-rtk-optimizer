# dsh-rtk-optimizer

[![npm version](https://img.shields.io/npm/v/dsh-rtk-optimizer.svg)](https://www.npmjs.com/package/dsh-rtk-optimizer)

RTK 命令改写建议 + 工具输出压缩——DSH 插件（Host 拦截器），移植自 Pi Coding Agent 生态的 [pi-rtk-optimizer](https://github.com/MasuRii/pi-rtk-optimizer)。

不注册模型工具：它挂在两个工具事件上，全局生效（对所有会话的 `bash`/`grep`/`read` 调用），并提供 `/rtk` 命令查看状态。

## 功能

### 1. RTK 命令改写（`tools/pre-execute`）

模型调用 `bash` 时，若本机装有 `rtk` 二进制（`rtk rewrite <command>`），插件：

- **`mode: rewrite`（默认关闭，需 /rtk 切换）**——deny 一次该调用，并在错误反馈中给出改写后的命令；模型重试时用新命令（rtk 幂等，不会循环；同一命令 30s 内只 deny 一次）。
- **`mode: suggest`（默认）**——不打断调用，在结果末尾附注 `[rtk-optimizer] rtk suggests: ...`。

> DSH 工具参数在分发管道中不可变（`tools/execute` 只能改 `exec.signal`），所以"自动改写"以 deny+反馈的形式实现——这是架构允许下最接近自动改写的语义。
> `rtk` 未安装时：原命令原样执行（`guardWhenRtkMissing: true`），探测结果缓存 60s，不重复 probe。

### 2. 输出压缩（`tools/post-execute`）

对成功返回的 `bash`/`grep`/`read` 文本输出按配置走压缩管线（可单独开关）：

| 阶段 | 说明 |
|---|---|
| ANSI 剥离 | 移除 CSI/OSC 颜色控制序列 |
| Git 压缩 | `git status --short` 行汇总为一行统计；40 位 commit hash 缩短为 7 位 |
| 测试聚合 | 保留 `Tests: N passed, M failed` 总结与失败行，折叠其余（jest/mocha/vitest/go test/pytest 命令触发） |
| 构建过滤 | 只保留 error/warning 行 + 汇总统计（build/tsc/make/npm 等命令触发） |
| 搜索分组 | `path:line:content` 行按文件分组（`grep` 工具输出） |
| 智能截断 | 超 `maxOutputChars`（默认 30000）时保留头 + 尾，中间打截断标记 |

统计每个调用的节省字符数，`/rtk stats` 可查。

### 3. `/rtk` 命令

`/rtk [show|verify|stats|clear-stats|reset|set|help]`——配置与运行状态、rtk 二进制探测、压缩节省量统计。

| 子命令 | 说明 |
|---|---|
| `show` | 当前配置 + rtk 二进制状态 + 统计 |
| `verify` | 检查 rtk 二进制是否可用（探测结果缓存 60s） |
| `stats` / `clear-stats` | 查看 / 重置压缩节省量统计 |
| `set <key> <value>` | 运行时切换：`mode`（suggest\|rewrite）、`enabled`、`guardWhenRtkMissing`、`readCompaction` |
| `reset` | 恢复默认配置 |

> 实现适配：rtk 0.43 对成功改写返回**退出码 3**（非文档所述 0），插件同时接受 0 与 3；不支持的命令退出 1 且无输出，命令原样放行。

## 安装

```bash
dsh plugin --profile <name> add dsh-rtk-optimizer
```

安装后重启 DSH，压缩与改写对全部会话的 `bash`/`grep`/`read` 调用生效（`/rtk` 命令可查状态与统计）。

## 开发

```bash
npm test   # 20 用例：ANSI、git 压缩、搜索分组、测试聚合、构建过滤、截断、总管线、静态求值
```

## 参考

- [pi-rtk-optimizer (GitHub)](https://github.com/MasuRii/pi-rtk-optimizer)
- [pi-rtk-optimizer (npm)](https://www.npmjs.com/package/pi-rtk-optimizer)
