// dsh-rtk-optimizer — Host half.
// ============================================================================
// ONE self-contained JavaScript FUNCTION BODY, evaluated by DSH as
// `(async () => { <this file> })()`. It doubles as the `code.host` source for
// cordis_define AND as the static-mount body loaded by index.js — this plugin
// registers no model tools, so it needs no harness/staticTool adapter; it
// listens to tool events and registers one /rtk command.
//
// Port of pi-rtk-optimizer (npm, MasuRii) for the Pi coding agent.
//
// What it does:
//   • tools/pre-execute  — when the model calls `bash`, run `rtk rewrite`
//     (if the rtk binary is installed) and, in `rewrite` mode, deny the call
//     once with the rewritten command as corrective feedback; in `suggest`
//     mode the suggestion is attached to the result instead. DSH tool
//     arguments are immutable, so auto-rewriting is impossible — deny +
//     feedback is the faithful equivalent of "automatic rewriting".
//   • tools/post-execute — compact noisy successful output of bash / grep /
//     read (config-gated) through a pipeline: ANSI strip, git compaction,
//     search grouping, test aggregation, build filtering, smart truncation.
//   • /rtk command        — show config & runtime status, verify the rtk
//     binary, and show/clear compaction stats.
// ============================================================================

//PURE-CORE-START
const DEFAULT_CONFIG = {
  enabled: true,
  mode: 'suggest', // 'rewrite' | 'suggest'
  guardWhenRtkMissing: true,
  rewriteTimeoutMs: 2000,
  suggestNoteMaxCommands: 1,
  debug: false, // attach rtk-path diagnostics to tool output
  outputCompaction: {
    enabled: true,
    stripAnsi: true,
    readCompaction: false,
    compactGitOutput: true,
    aggregateTestOutput: true,
    filterBuildOutput: true,
    groupSearchOutput: true,
    maxOutputChars: 30000,
    tailRatio: 0.4
  }
}

const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
const ANSI_OSC_RE = /\u001b\][^\u0007]*(\u0007|\u001b\\)/g

/** Strip ANSI color/control sequences (CSI + OSC + stray ESC). */
function stripAnsi(text) {
  return text.replace(ANSI_OSC_RE, '').replace(ANSI_RE, '').replace(/\u001b/g, '')
}

const GIT_STATUS_SHORT_RE = /^([ MARCUD?!]{1,2}) (.+)$/
const GIT_COMMIT_FULL_RE = /^commit ([0-9a-f]{40,})(.*)$/
const GIT_COMMIT_SHORT_RE = /^commit ([0-9a-f]{7,})(.*)$/

/**
 * Compact common git plumbing output.
 *  - `git status --short` rows → one summary line
 *  - full 40-char commit hashes → short hashes (keeps log shape)
 * Indented lines whose flag column trims to empty (e.g. diff context or
 * log bodies) are never treated as status rows.
 */
function compactGitOutput(text) {
  const lines = text.split('\n')
  const out = []
  let statusCounts = { M: 0, A: 0, D: 0, R: 0, C: 0, U: 0, '??': 0, other: 0 }
  let statusRows = 0
  for (const line of lines) {
    const s = line.match(GIT_STATUS_SHORT_RE)
    if (s && s[1].trim().length > 0) {
      statusRows++
      const flag = s[1].trim()
      if (flag in statusCounts) statusCounts[flag]++
      else statusCounts.other++
      continue
    }
    const c = line.match(GIT_COMMIT_FULL_RE)
    if (c) {
      out.push(`commit ${c[1].slice(0, 7)}${c[2]}`)
      continue
    }
    out.push(line)
  }
  if (statusRows > 0) {
    const parts = []
    for (const [flag, count] of Object.entries(statusCounts)) {
      if (count > 0) parts.push(`${flag} ${count}`)
    }
    out.push(`[git status summary: ${statusRows} path(s) — ${parts.join(', ')}]`)
  }
  return out.join('\n')
}

const SEARCH_ROW_RE = /^([^:]+):(\d+):(.*)$/

/**
 * Group grep/rg-style `path:line:content` rows by file. Rows that do not
 * match the pattern pass through unchanged.
 */
function groupSearchOutput(text) {
  const lines = text.split('\n')
  const out = []
  const groups = new Map() // path → { count, rows: [{line, content}] }
  const order = []
  const passthrough = []
  for (const line of lines) {
    const m = line.match(SEARCH_ROW_RE)
    if (m && !/^\/\//.test(m[1])) {
      let g = groups.get(m[1])
      if (!g) {
        g = { count: 0, rows: [] }
        groups.set(m[1], g)
        order.push(m[1])
      }
      g.count++
      if (g.rows.length < 50) g.rows.push({ line: m[2], content: m[3] })
    } else {
      passthrough.push(line)
    }
  }
  if (groups.size === 0) return text
  for (const path of order) {
    const g = groups.get(path)
    out.push(`${path} (${g.count} match${g.count === 1 ? '' : 'es'})`)
    for (const row of g.rows) out.push(`  ${row.line}: ${row.content}`)
    if (g.count > g.rows.length) out.push(`  ... (+${g.count - g.rows.length} more)`)
  }
  if (passthrough.some((l) => l.length > 0)) {
    out.push('---')
    out.push(...passthrough)
  }
  return out.join('\n')
}

const TEST_SUMMARY_RE = /(Tests|test cases|tests|passed|failed|failed,|passed,)[^|]*\b(\d+) (passed|failed|skipped)\b[^|]*/i
const GO_TEST_OK_RE = /^ok\s+[\w./-]+/
const PYTEST_RE = /^=+ .* (passed|failed|error).* =+$/i

/**
 * Aggregate common test-runner output: keep summary and failure lines, fold
 * the rest. Heuristic and conservative — unmatched output passes through.
 * `FAIL <path>` lines (jest/mocha) are treated as failures, NOT as go-test
 * summaries, so the real `Tests:` summary line stays the single summary.
 */
function aggregateTestOutput(text) {
  const lines = text.split('\n')
  const out = []
  let folded = 0
  let sawSummary = false
  let sawFailures = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (TEST_SUMMARY_RE.test(line) || /Tests:\s+\d+/.test(line) || /(^|\s)\d+ (passed|failed|skipped)(\s|,|$)/.test(trimmed)) {
      if (!sawSummary) {
        out.push(`[test summary] ${trimmed}`)
        sawSummary = true
      }
      continue
    }
    if (GO_TEST_OK_RE.test(trimmed) || PYTEST_RE.test(line)) {
      out.push(trimmed)
      sawSummary = true
      continue
    }
    if (/✗|✘|×|FAILED|FAIL\b|Error:|error:|AssertionError|Expected|Received|at Object\.|at Test\./i.test(line) && !/^PASS\b/.test(trimmed)) {
      out.push(line)
      sawFailures = true
      continue
    }
    if (sawFailures && /^(\s{2,}|$)/.test(line)) {
      // collapse indented failure detail tails after the first few lines
      if (out.length > 0 && !out[out.length - 1].startsWith('...')) out.push('...')
      folded++
      continue
    }
    folded++
  }
  if (!sawSummary && folded < 3) return text
  if (out.length === 0) return text
  const header = sawSummary ? '' : '[test output aggregated]'
  const body = out.join('\n')
  const note = folded > 0 ? `\n[... ${folded} line(s) folded by rtk-optimizer]` : ''
  return `${header ? header + '\n' : ''}${body}${note}`
}

const BUILD_SIGNAL_RE = /\b(error|errors?|warning|warnings?|failed|failure|failed to|fatal|cannot find|undefined reference|exit code [1-9])\b/i

/** Keep build/compile output lines that carry errors or warnings plus a tail summary. */
function filterBuildOutput(text) {
  const lines = text.split('\n')
  const kept = []
  let dropped = 0
  for (const line of lines) {
    if (BUILD_SIGNAL_RE.test(line)) kept.push(line)
    else dropped++
  }
  if (kept.length === 0 || dropped === 0) return text
  const summary = `[build output filtered: kept ${kept.length} error/warning line(s), dropped ${dropped}]`
  return `${kept.join('\n')}\n${summary}`
}

/** Keep the head and a configurable tail when the text exceeds maxChars. */
function truncateText(text, maxChars, tailRatio) {
  if (text.length <= maxChars) return { text, truncated: false }
  const tailLen = Math.floor(maxChars * tailRatio)
  const headLen = maxChars - tailLen
  const marker = `\n[... output truncated by rtk-optimizer: ${text.length - maxChars} char(s) removed, tail follows ...]\n`
  return {
    text: text.slice(0, headLen) + marker + text.slice(text.length - tailLen),
    truncated: true
  }
}

function countSaved(original, compacted) {
  return original.length - compacted.length
}

/**
 * The full compaction pipeline for one tool output. Applies the enabled
 * stages in order; returns the compacted text plus bytes saved.
 * `commandHint` is the executed command line (bash), used to decide which
 * stages apply; every stage is content-guarded and passes output through
 * unchanged when it does not match, so a wrong hint is harmless.
 */
function compactOutput(toolName, text, config, commandHint) {
  if (!config || !config.outputCompaction || !config.outputCompaction.enabled) {
    return { text, savedChars: 0 }
  }
  const oc = config.outputCompaction
  const cmd = typeof commandHint === 'string' ? commandHint : ''
  let out = text
  if (oc.stripAnsi) out = stripAnsi(out)
  if (oc.compactGitOutput && toolName === 'bash' && /git (status|log|diff|show)\b/.test(cmd)) {
    out = compactGitOutput(out)
  }
  if (oc.aggregateTestOutput && toolName === 'bash' && /(jest|mocha|vitest|go test|pytest|npm test|npx t|pnpm test|gradle test|mvn test)\b/i.test(cmd)) {
    out = aggregateTestOutput(out)
  }
  if (oc.filterBuildOutput && toolName === 'bash' && /\b(build|compile|tsc|make|gcc|clang|go build|npm (run )?(build|install)|pnpm (build|install))\b/i.test(cmd)) {
    out = filterBuildOutput(out)
  }
  if (oc.groupSearchOutput && toolName === 'grep') {
    out = groupSearchOutput(out)
  }
  if (oc.readCompaction && toolName === 'read') {
    out = compactReadOutput(out)
  }
  const truncated = truncateText(out, oc.maxOutputChars, oc.tailRatio)
  return { text: truncated.text, savedChars: countSaved(text, truncated.text), truncated: truncated.truncated }
}

/** Conservative read compaction: collapse runs of blank lines only. */
function compactReadOutput(text) {
  return text.replace(/\n{3,}/g, '\n\n')
}

const rtkCore = {
  DEFAULT_CONFIG,
  stripAnsi,
  compactGitOutput,
  groupSearchOutput,
  aggregateTestOutput,
  filterBuildOutput,
  truncateText,
  compactReadOutput,
  compactOutput,
  countSaved
}
//PURE-CORE-END

// ============================================================================
// Plugin
// ============================================================================
const COMPACT_TOOL_NAMES = new Set(['bash', 'grep', 'read'])
const RTK_MISSING_TTL_MS = 60000
function errText(e) {
  return e && typeof e === 'object' && typeof e.message === 'string' ? e.message : String(e)
}

return {
  // Hard dependencies so cordis parks this plugin until the services exist
  // (static mount: bundle rows load in parallel; without this, apply() could
  // run before subprocess/commands/timer are mounted and silently degrade).
  inject: ['subprocess', 'commands', 'timer'],
  apply(ctx) {
    const subprocess = ctx.get('subprocess')
    const commands = ctx.get('commands')
    const timer = ctx.get('timer')
    const config = { ...DEFAULT_CONFIG }

    // ── Runtime state ──
    const state = {
      rtkResolved: undefined, // string path | null (missing) | undefined (unknown)
      rtkCheckedAt: 0,
      stats: { calls: 0, compacted: 0, savedChars: 0, byTool: {} },
      suggestions: new Map(), // callId → rewritten command (suggest mode)
      denyGuard: new Map(), // command → last deny ts (anti-loop)
      hookPlan: new Map(), // callId → rewritten command (hook mode)
      hookExecuted: new Map() // callId → rewritten command actually executed (for post-execute note)
    }

    function sessionCwd(exec) {
      return exec.agent && exec.agent.session && exec.agent.session.header
        ? exec.agent.session.header.cwd
        : undefined
    }
    function cfg() {
      return config
    }
    function now() {
      return Date.now()
    }

    // ── rtk binary access ──
    // `force` bypasses the missing-binary cache so an explicit user command
    // (/rtk verify, /rtk show) always gets an authoritative, fresh answer.
    async function resolveRtk(signal, force = false) {
      if (subprocess === undefined) return undefined
      const stale = state.rtkCheckedAt === 0 || now() - state.rtkCheckedAt > RTK_MISSING_TTL_MS
      if (!force && state.rtkResolved !== undefined && !stale) return state.rtkResolved
      try {
        const exe = await subprocess.resolveExecutable('rtk', undefined, signal)
        state.rtkResolved = exe
        state.rtkCheckedAt = now()
        return exe
      } catch (e) {
        if (config.debug) console.error(`dsh-rtk-optimizer: resolveExecutable(rtk) failed: ${errText(e)}`)
        state.rtkResolved = null
        state.rtkCheckedAt = now()
        return undefined
      }
    }
    async function rtkRewrite(exe, cwd, command, signal) {
      try {
        const handle = subprocess.spawn({
          argv: [exe, 'rewrite', command],
          cwd,
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: 8192 },
            stderr: { maxBytes: 4096 }
          },
          graceMs: 300,
          signal
        })
        let outcome
        if (timer !== undefined && config.rewriteTimeoutMs > 0) {
          outcome = await Promise.race([
            handle.done,
            timer.timeout(config.rewriteTimeoutMs).then(() => { handle.terminate(); return undefined })
          ])
        } else {
          outcome = await handle.done
        }
        // rtk 0.43 exits 3 (not 0) on successful rewrites; 1 means "no
        // equivalent" with no stdout. Accept 0 and 3.
        if (!outcome || (outcome.exitCode !== 0 && outcome.exitCode !== 3)) {
          if (config.debug) console.error(`dsh-rtk-optimizer: rtk rewrite exit=${outcome ? outcome.exitCode : 'timeout'}`)
          return undefined
        }
        const reader = handle.collected && handle.collected.stdout
        const text = reader ? (await reader.readFrom(0)).text : ''
        const rewritten = text.trim()
        if (config.debug) console.error(`dsh-rtk-optimizer: rtk rewrite of "${command}" → "${rewritten}"`)
        return rewritten.length > 0 && rewritten !== command ? rewritten : undefined
      } catch (e) {
        if (config.debug) console.error(`dsh-rtk-optimizer: rtk rewrite threw: ${errText(e)}`)
        return undefined
      }
    }

    // ── rtk hook-mode rewrite: consult the rtk agent-hook engine (`rtk hook claude`)
    // Reads a Claude Code PreToolUse event from stdin and returns the rewritten
    // command from `updatedInput.command`, or undefined when rtk suggests no change.
    async function rtkHookRewrite(exe, cwd, command, signal) {
      const payload = JSON.stringify({
        session_id: 'dsh-rtk-optimizer',
        cwd,
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command }
      })
      try {
        const handle = subprocess.spawn({
          argv: [exe, 'hook', 'claude'],
          cwd,
          stdio: {
            stdin: { data: payload },
            stdout: { maxBytes: 8192 },
            stderr: { maxBytes: 4096 }
          },
          graceMs: 300,
          signal
        })
        let outcome
        if (timer !== undefined && config.rewriteTimeoutMs > 0) {
          outcome = await Promise.race([
            handle.done,
            timer.timeout(config.rewriteTimeoutMs).then(() => { handle.terminate(); return undefined })
          ])
        } else {
          outcome = await handle.done
        }
        if (!outcome || outcome.exitCode !== 0) {
          if (config.debug) console.error(`dsh-rtk-optimizer: rtk hook exit=${outcome ? outcome.exitCode : 'timeout'}`)
          return undefined
        }
        const reader = handle.collected && handle.collected.stdout
        const text = reader ? (await reader.readFrom(0)).text : ''
        if (!text) return undefined
        let parsed
        try {
          parsed = JSON.parse(text)
        } catch (e) {
          if (config.debug) console.error(`dsh-rtk-optimizer: rtk hook output not JSON: ${errText(e)}`)
          return undefined
        }
        const rewritten = parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.updatedInput
          ? parsed.hookSpecificOutput.updatedInput.command
          : undefined
        if (config.debug) console.error(`dsh-rtk-optimizer: rtk hook of "${command}" → "${rewritten}"`)
        return typeof rewritten === 'string' && rewritten.length > 0 && rewritten !== command ? rewritten : undefined
      } catch (e) {
        if (config.debug) console.error(`dsh-rtk-optimizer: rtk hook threw: ${errText(e)}`)
        return undefined
      }
    }

    // ── tools/pre-execute: rtk rewrite suggestion / deny ──
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (!config.enabled || exec.name !== 'bash') return next()
      const command = exec.arguments && typeof exec.arguments.command === 'string'
        ? exec.arguments.command
        : undefined
      if (!command) return next()
      const cwd = sessionCwd(exec)
      if (cwd === undefined) return next()
      const exe = await resolveRtk(exec.signal)
      if (exe === undefined) {
        if (!config.guardWhenRtkMissing) {
          return { kind: 'deny', reason: 'rtk-optimizer: the rtk binary is not available; this command was not rewritten. Install rtk or set guardWhenRtkMissing=false.' }
        }
        if (config.debug && !state.rtkMissingNoted) {
          state.rtkMissingNoted = true
          state.suggestions.set(exec.callId, `rtk binary not found on PATH; commands run unchanged. (install rtk or /rtk verify)`)
        }
        return next()
      }
      const rewritten = config.mode === 'hook'
        ? await rtkHookRewrite(exe, cwd, command, exec.signal)
        : await rtkRewrite(exe, cwd, command, exec.signal)
      if (rewritten === undefined) {
        if (config.debug && !state.rewriteFailureNoted) {
          state.rewriteFailureNoted = true
          state.suggestions.set(exec.callId, `rtk rewrite failed for "${command.slice(0, 80)}"; commands run unchanged.`)
        }
        return next()
      }

      if (config.mode === 'rewrite') {
        // Anti-loop: never deny the same command twice within 30s.
        const lastDeny = state.denyGuard.get(command) ?? 0
        if (now() - lastDeny < 30000) return next()
        state.denyGuard.set(command, now())
        return {
          kind: 'deny',
          reason: `[rtk-optimizer] Run this rtk-rewritten command instead (${rewritten.length} chars, was ${command.length}):\n${rewritten}`
        }
      }
      if (config.mode === 'hook') {
        state.hookPlan.set(exec.callId, rewritten)
        return next()
      }
      // suggest mode: remember for post-execute enrichment
      state.suggestions.set(exec.callId, rewritten)
      if (state.suggestions.size > 64) {
        const oldest = state.suggestions.keys().next().value
        state.suggestions.delete(oldest)
      }
      return next()
    })

    // ── tools/execute: hook mode replaces execution with `rtk <cmd>` ──
    ctx.on('tools/execute', async (exec, next) => {
      if (!config.enabled || config.mode !== 'hook' || exec.name !== 'bash') return next()
      const rewritten = state.hookPlan.get(exec.callId)
      if (rewritten === undefined) return next()
      state.hookPlan.delete(exec.callId)
      const cwd = sessionCwd(exec)
      if (cwd === undefined) return next()
      const timeoutMs = exec.arguments && Number.isFinite(exec.arguments.timeoutMs) && exec.arguments.timeoutMs > 0
        ? exec.arguments.timeoutMs
        : 120000
      try {
        const handle = subprocess.spawn({
          argv: ['/bin/bash', '-c', rewritten],
          cwd,
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: 1000000, spill: { maxBytes: 10000000 } },
            stderr: { maxBytes: 100000, spill: { maxBytes: 1000000 } }
          },
          graceMs: 300,
          signal: exec.signal
        })
        let outcome
        if (timer !== undefined) {
          outcome = await Promise.race([
            handle.done,
            timer.timeout(timeoutMs).then(() => { handle.terminate(); return undefined })
          ])
        } else {
          outcome = await handle.done
        }
        const readStream = async (reader) => {
          if (!reader) return { text: '', truncated: false }
          const read = await reader.readFrom(0)
          return { text: read.text, truncated: read.lossy === true }
        }
        const stdout = await readStream(handle.collected && handle.collected.stdout)
        const stderr = await readStream(handle.collected && handle.collected.stderr)
        const timedOut = outcome === undefined
        state.hookExecuted.set(exec.callId, rewritten)
        return {
          value: {
            kind: 'foreground',
            exitCode: timedOut ? null : outcome.exitCode,
            signal: timedOut ? 'SIGTERM' : outcome.signal,
            timedOut,
            aborted: exec.signal && exec.signal.aborted === true,
            timeoutMs,
            stdout,
            stderr
          }
        }
      } catch (e) {
        if (config.debug) console.error(`dsh-rtk-optimizer: hook execute threw: ${errText(e)}`)
        return next()
      }
    })

    // ── tools/post-execute: output compaction + suggestion note ──
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const suggestion = state.suggestions.get(exec.callId)
      state.suggestions.delete(exec.callId)

      let compactedBlocks
      let savedChars = 0
      if (config.enabled && config.outputCompaction.enabled && !result.isError && COMPACT_TOOL_NAMES.has(exec.name)) {
        const blocks = result.content
        const textBlock = blocks.find((b) => b && b.type === 'text' && typeof b.text === 'string')
        if (textBlock) {
          const original = textBlock.text
          const commandHint = exec.name === 'bash' && exec.arguments && typeof exec.arguments.command === 'string'
            ? exec.arguments.command
            : undefined
          const out = compactOutput(exec.name, original, config, commandHint)
          if (out.text !== original) {
            compactedBlocks = blocks.map((b) => (b === textBlock ? { type: 'text', text: out.text } : b))
            savedChars = out.savedChars
          }
        }
      }

      if (suggestion !== undefined && !result.isError) {
        const isNote = suggestion.startsWith('rtk ') || suggestion.startsWith('rtk binary') || suggestion.startsWith('rtk rewrite failed')
        const note = isNote
          ? `[rtk-optimizer] ${suggestion}`
          : `[rtk-optimizer] rtk suggests: ${suggestion}`
        const blocks = result.content
        const existing = blocks.some((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.includes('[rtk-optimizer]'))
        if (!existing) {
          compactedBlocks = [...(compactedBlocks ?? blocks), { type: 'text', text: note }]
        }
      }

      // hook mode: prefix a note that the command was replaced by its rtk form
      const hookExecuted = state.hookExecuted.get(exec.callId)
      state.hookExecuted.delete(exec.callId)
      if (hookExecuted !== undefined && !result.isError) {
        const note = `[rtk-optimizer] hook: executed as "${hookExecuted}"`
        const blocks = result.content
        const existing = blocks.some((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.includes('[rtk-optimizer]'))
        if (!existing) {
          compactedBlocks = [{ type: 'text', text: note }, ...(compactedBlocks ?? blocks)]
        }
      }

      if (compactedBlocks === undefined) return next()

      state.stats.calls += 1
      if (savedChars > 0) {
        state.stats.compacted += 1
        state.stats.savedChars += savedChars
        state.stats.byTool[exec.name] = (state.stats.byTool[exec.name] ?? 0) + savedChars
      }
      return { kind: 'accept', content: compactedBlocks }
    })

    // ── /rtk command ──
    if (commands !== undefined) {
      commands.register({
        name: 'rtk',
        description: 'RTK optimizer status: show config, verify the rtk binary, or show compaction stats.',
        input: { hint: 'show | verify | stats | clear-stats | reset | help' },
        handler: async (invocation) => {
          const line = invocation.rawInput.trim()
          try {
            const c = cfg()
            const [verb, ...rest] = line.split(/\s+/)
            switch (verb) {
              case 'set': {
                const key = rest[0]
                const value = rest[1]
                if (key === 'mode' && (value === 'suggest' || value === 'rewrite' || value === 'hook')) {
                  c.mode = value
                  return { kind: 'success', text: `rtk-optimizer mode set to ${value}.` }
                }
                if (key === 'enabled' && (value === 'true' || value === 'false')) {
                  c.enabled = value === 'true'
                  return { kind: 'success', text: `rtk-optimizer enabled=${c.enabled}.` }
                }
                if (key === 'guardWhenRtkMissing' && (value === 'true' || value === 'false')) {
                  c.guardWhenRtkMissing = value === 'true'
                  return { kind: 'success', text: `rtk-optimizer guardWhenRtkMissing=${c.guardWhenRtkMissing}.` }
                }
                if (key === 'readCompaction' && (value === 'true' || value === 'false')) {
                  c.outputCompaction.readCompaction = value === 'true'
                  return { kind: 'success', text: `rtk-optimizer readCompaction=${c.outputCompaction.readCompaction}.` }
                }
                return { kind: 'error', text: 'usage: /rtk set <key> <value> — keys: mode (suggest|rewrite|hook), enabled (true|false), guardWhenRtkMissing (true|false), readCompaction (true|false)' }
              }
              case 'show': {
                // Probe (fresh) so the status is truthful even before the first
                // bash call — previously it stayed "not probed yet" forever.
                const exe = await resolveRtk(undefined, true)
                const rtkState = exe === undefined ? 'missing' : exe
                return {
                  kind: 'success',
                  text: [
                    'rtk-optimizer:',
                    `  enabled: ${c.enabled}`,
                    `  mode: ${c.mode}`,
                    `  guardWhenRtkMissing: ${c.guardWhenRtkMissing}`,
                    `  rtk binary: ${rtkState}`,
                    `  compaction: ${c.outputCompaction.enabled} (stripAnsi=${c.outputCompaction.stripAnsi}, git=${c.outputCompaction.compactGitOutput}, tests=${c.outputCompaction.aggregateTestOutput}, build=${c.outputCompaction.filterBuildOutput}, search=${c.outputCompaction.groupSearchOutput}, read=${c.outputCompaction.readCompaction}, maxChars=${c.outputCompaction.maxOutputChars})`,
                    `  stats: ${state.stats.calls} call(s), ${state.stats.compacted} compacted, ${state.stats.savedChars} char(s) saved`
                  ].join('\n')
                }
              }
              case 'verify': {
                // The point of "verify" is to check the binary NOW: force a
                // fresh probe instead of reporting the stale cached state.
                const exe = await resolveRtk(undefined, true)
                if (exe === undefined) return { kind: 'success', text: 'rtk binary: NOT FOUND on PATH (rewrites disabled, original commands run unchanged)' }
                return { kind: 'success', text: `rtk binary: ${exe}` }
              }
              case 'stats': {
                const byTool = Object.entries(state.stats.byTool)
                  .map(([tool, saved]) => `  ${tool}: ${saved} char(s) saved`)
                  .join('\n')
                return {
                  kind: 'success',
                  text: [
                    `calls observed: ${state.stats.calls}`,
                    `compacted: ${state.stats.compacted}`,
                    `total saved: ${state.stats.savedChars} char(s)`,
                    byTool
                  ].join('\n')
                }
              }
              case 'clear-stats': {
                state.stats.calls = 0
                state.stats.compacted = 0
                state.stats.savedChars = 0
                state.stats.byTool = {}
                return { kind: 'success', text: 'rtk-optimizer stats cleared.' }
              }
              case 'reset': {
                Object.assign(config, JSON.parse(JSON.stringify(DEFAULT_CONFIG)))
                return { kind: 'success', text: 'rtk-optimizer config reset to defaults.' }
              }
              case 'help':
              case '': {
                return {
                  kind: 'success',
                  text: 'rtk-optimizer: /rtk [show|verify|stats|clear-stats|reset|set|help]\n  show        current configuration and runtime status\n  verify      check whether the rtk binary is available\n  stats       compaction savings for this process\n  clear-stats reset the counters\n  set         /rtk set <key> <value> (mode(suggest|rewrite|hook)|enabled|guardWhenRtkMissing|readCompaction)\n  reset       restore default configuration'
                }
              }
              default:
                return { kind: 'error', text: `unknown /rtk subcommand "${verb}" (try /rtk help)` }
            }
          } catch (e) {
            return { kind: 'error', text: `rtk command failed: ${e && e.message ? e.message : String(e)}` }
          }
        }
      })
    }

    console.log('dsh-rtk-optimizer: pre/post-execute hooks + /rtk command registered')
  }
}
