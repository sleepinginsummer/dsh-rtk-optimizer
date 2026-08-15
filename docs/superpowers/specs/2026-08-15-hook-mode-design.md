# dsh-rtk-optimizer: `hook` 模式设计

日期：2026-08-15
状态：已获用户批准（brainstorming 阶段）

## 背景与动机

dsh-rtk-optimizer 是运行在 DSH（DeepSeek Harness）上的插件，在模型调用 `bash` 工具时
通过 rtk 二进制改写命令并压缩输出。现有两种模式：

- `suggest`（默认）：命令照常执行，在结果末尾附注 `[rtk-optimizer] rtk suggests: ...`。
- `rewrite`（默认关闭，需 `/rtk set mode rewrite`）：deny 一次该调用，在错误反馈中给出
  改写后的命令；模型重试时使用新命令（rtk 幂等不会循环；同一命令 30s 内只 deny 一次）。

用户需要第三种模式 `hook`：**让命令真正以 `rtk <cmd>` 的形式执行**，从而：

1. 命令输出经过 rtk 的 token 过滤（真正的"直接 hook"）。
2. rtk 包装器执行时会写入 `~/.local/share/rtk/history.db`，`rtk gain` 的
   `Total commands` 可见增长（已实测：裸 `ls` 不改计数；`rtk ls` 执行后计数 +1）。

## 已确认的 DSH 契约（调研结论）

- DSH bash 工具由 `ctx.shell`（`dsh-terminal-bash`）以 PTY spawn
  `/bin/bash --noprofile --norc` 执行，**rc 文件被禁用**，所以 shell 级 hook
  （如写入 `~/.bashrc`）对 DSH 永不生效。
- rtk 的 hook 机制是 **agent 级 hook**（`rtk hook claude|cursor|gemini|copilot|droid|vibe`），
  通过读 stdin JSON 处理 agent 工具调用；`rtk init -g` 只给 Claude Code 等安装，对 DSH 无效。
- `tools/pre-execute` waterfall 只支持 `kind: 'allow' | 'ask' | 'deny'`；deny 仅返回
  `Error: reason`，**无替换 content 能力**（`dsh-tools/lib/types/index.js:870`）。
- `tools/execute` waterfall 的默认 body 是 `dispatchToolBody`（`dsh-tools:967`），
  其返回经 `normalizeDispatchResult` 处理：**若返回 `{ value }` 则短路，
  跳过真正的工具执行，直接产出结果**（`dsh-tools:1209-1227`）。
  `value` 需符合工具 output schema（bash：`{ kind: 'foreground', exitCode, signal,
  timedOut, timeoutMs, stdout: {text, truncated}, stderr: {...} }`）。
- `exec.arguments` 在 mint 时被 `deepFreeze`（`dsh-tools:817`），**参数不可改写**，
  因此"替换执行"必须走 `tools/execute` 短路，而不是改参数让 bash 工具执行 `rtk <cmd>`。
- rtk 统计写入条件（实测）：`rtk hook claude` 只返回改写建议不写库；
  **实际执行 `rtk <cmd>` 包装器才写 history.db**（3323 → 3324）。

## 设计

### 1. 模式语义

新增第三个 mode 值 `'hook'`，通过 `/rtk set mode hook` 切换；`rewrite`/`suggest` 不变。

| 模式 | 行为 | 统计计入 rtk gain |
|---|---|---|
| `suggest`（默认） | 命令照常执行，末尾附注建议 | ❌ |
| `rewrite` | deny 一次 + 反馈改写命令，模型重试 | ❌ |
| `hook`（新增） | 插件内部把命令替换为 `rtk <cmd>` 实际执行 | ✅（+1） |

### 2. 管线改造

#### `tools/pre-execute`（现有 handler 内扩展）

- 条件：`config.enabled && mode === 'hook' && exec.name === 'bash'`，且
  `sessionCwd(exec)` 可得。
- 解析 rtk 二进制（复用 `resolveRtk`，force=false）。
- 将 DSH 的 exec 事件转换为 Claude Code PreToolUse JSON 并 spawn
  `rtk hook claude`（stdin 输入 JSON，类似 `rtkRewrite` 的 spawn 模式），
  解析返回的 `updatedInput.command` 作为改写结果。
- 若改写成功且 `rewritten !== command`：写入
  `state.hookPlan.set(exec.callId, rewritten)`，然后 `next()` **放行**
  （不 deny，不打断模型）。
- 否则（rtk 缺失 / hook 失败 / 无改写）：`next()` 放行原命令，无副作用。

#### `tools/execute`（新增监听）

- 条件：mode === 'hook' 且 `state.hookPlan.has(exec.callId)`。
- 取出 rewritten，清除 plan。
- 用 `subprocess.spawn` 执行 `rtk <rewritten>`（cwd = session cwd，带
  `exec.signal` 和超时：优先 `config.rewriteTimeoutMs` 或 `exec.arguments.timeoutMs`，
  超时则 `handle.terminate()`）。
- 收集 stdout/stderr，构造符合 bash schema 的结果对象并**短路返回**
  `{ value: { kind: 'foreground', exitCode, signal, timedOut, timeoutMs,
  stdout: {text, truncated}, stderr: {text, truncated} } }`。
- 异常/超时兜底：返回 `next()` 放行原命令（功能不破坏）。

#### `tools/post-execute`（现有 handler 内扩展）

- hook 模式下**不附加 suggest 注记**（输出已被 rtk 过滤），compaction 保留
  （`state.suggestions` 未写入，天然跳过注记；compaction 照常）。
- 在结果 text 前增加一行来源标注：`[rtk-optimizer] hook: executed as "rtk ls"`，
  让模型知道命令已被替换执行（明确决定，非可选）。

### 3. 关键约束与兜底

- `exec.arguments` 不可改写 → 替换必须走 `tools/execute` 短路（已确认可行）。
- **spawn 异常 / rtk 缺失 / 无改写** → 清除 plan，`next()` 放行原命令（此时原命令尚未执行，放行安全）。
- **执行超时** → 返回超时结果 `{ kind: 'foreground', timedOut: true, ... }`（rtk 包装器可能已执行一半，放行会重复执行原命令，故不放行）。
- **安全考量**：短路会绕过 DSH 的 bash sandbox（原命令由 rtk 包装器执行）。
  设计上：hook 模式默认在 `enabled` 且 rtk 可用时生效；README 显著标注此风险，
  建议仅在可信环境下开启 hook 模式。

### 4. 统计验证闭环

`rtk <cmd>` 包装器执行时自动写 history.db（已验证 3323 → 3324），
因此 hook 模式下执行 `ls` → `rtk gain` 的 `Total commands` +1。

### 5. 测试

- 单测（复用 `test/command.test.js` 的 fake ctx 模式）：
  - `planHookRewrite`：PreToolUse JSON 构造与 `updatedInput.command` 解析。
  - `runRtkWrapper`：spawn `rtk <cmd>`、输出收集、超时终止。
  - hook plan 的写入/消费/清理（callId 生命周期）。
  - `/rtk help` 列出 hook 模式。
- E2E（手动，文档化于 README）：
  - `/rtk set mode hook` 后执行 `ls`，观察输出为 rtk 过滤结果。
  - `rtk gain` 的 `Total commands` 增长。

## 范围外（YAGNI）

- 不为 grep/read 工具做 hook 替换（保持 bash only）。
- 不实现 rtk 自身缺少的 agent hook 安装（`rtk init` 对 DSH 无效，此为 DSH 侧插件职责）。
- 不改变 rewrite/suggest 的既有行为。
