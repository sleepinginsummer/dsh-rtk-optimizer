'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const hostPath = path.join(__dirname, '..', 'src', 'host.js')
const hostBody = fs.readFileSync(hostPath, 'utf8')

/**
 * Mount the plugin with a fake ctx that captures tool pipeline handlers and
 * provides a scriptable subprocess.spawn.
 *
 * opts.spawnLog: array — each spawn call pushes { spec } here.
 * opts.spawnResult: { outcome, stdout, stderr } | Function(spec) → same — what
 *   each spawn returns. Default: exit 0 with empty stdout/stderr.
 * opts.probe: resolveExecutable impl (default: resolves to '/usr/local/bin/rtk').
 */
function mount(opts = {}) {
  const spawnLog = opts.spawnLog ?? []
  const handlers = {}
  const plugin = new Function(hostBody)()
  const fakeSpawn = (spec) => {
    spawnLog.push({ spec })
    const r = typeof opts.spawnResult === 'function' ? opts.spawnResult(spec) : opts.spawnResult
    // A thenable `r` means the caller scripts a spawn whose `done` never
    // settles (task-3 timeout test) so the timer branch of the execute race
    // wins; model it directly instead of wrapping a default outcome.
    if (r && typeof r.then === 'function') {
      return {
        done: r,
        terminate: () => {},
        collected: {
          stdout: { readFrom: async () => ({ text: '', nextOffset: 0, lossy: false }) },
          stderr: { readFrom: async () => ({ text: '', nextOffset: 0, lossy: false }) }
        }
      }
    }
    const outcome = r?.outcome ?? { exitCode: 0, signal: null }
    const stdoutText = r?.stdout ?? ''
    const stderrText = r?.stderr ?? ''
    const terminated = { terminated: false }
    return {
      done: Promise.resolve(outcome),
      terminate: () => { terminated.terminated = true },
      collected: {
        stdout: { readFrom: async () => ({ text: stdoutText, nextOffset: stdoutText.length, lossy: false }) },
        stderr: { readFrom: async () => ({ text: stderrText, nextOffset: stderrText.length, lossy: false }) }
      }
    }
  }
  const ctx = {
    get: (name) => {
      if (name === 'subprocess') return {
        // `probe` IS the resolveExecutable impl: invoke it so its throw/reject
        // propagates (task-2 missing-binary test relies on that). Default resolves.
        resolveExecutable: async (name, _o, signal) => {
          return typeof opts.probe === 'function' ? await opts.probe(signal) : '/usr/local/bin/rtk'
        },
        spawn: fakeSpawn
      }
      if (name === 'timer') return { timeout: () => Promise.resolve() }
      if (name === 'commands') return { register: (def) => { handlers.command = def.handler } }
      return undefined
    },
    on: (event, fn) => { handlers[event] = fn },
    provide: () => () => {}
  }
  plugin.apply(ctx)
  assert.ok(handlers.command, 'rtk command must be registered')
  return {
    handlers,
    runCommand: (rawInput) => handlers.command({ rawInput }),
    spawnLog,
    // helpers to build exec-like objects for pipeline handlers
    makeExec: (callId, command, extra = {}) => ({
      callId,
      name: 'bash',
      signal: { aborted: false },
      arguments: { command, ...extra },
      agent: { session: { header: { cwd: '/home/yjw/workspace/dsh-rtk-optimizer' } } }
    })
  }
}

// ── helpers used by later tasks ─────────────────────────────────────────────

/** Run the captured pre-execute handler with a fake exec; returns its return value. */
async function pre(t, callId, command, extra) {
  const exec = t.makeExec(callId, command, extra)
  let nextCalled = false
  const next = () => { nextCalled = true; return { kind: 'next' } }
  const out = await t.handlers['tools/pre-execute'](exec, next)
  return { out, nextCalled }
}

/** Run the captured execute handler; returns its return value. */
async function exec(t, callId, command, extra) {
  const execObj = t.makeExec(callId, command, extra)
  let nextCalled = false
  const next = () => { nextCalled = true; return { kind: 'next' } }
  const out = await t.handlers['tools/execute'](execObj, next)
  return { out, nextCalled }
}

/** Run the captured post-execute handler. */
async function post(t, callId, result) {
  const execObj = t.makeExec(callId, 'ls')
  let nextCalled = false
  const next = () => { nextCalled = true; return { kind: 'next' } }
  const out = await t.handlers['tools/post-execute'](execObj, result, next)
  return { out, nextCalled }
}

// ── Task 2 groundwork: /rtk set mode hook + help list hook ──────────────────

test('/rtk set mode hook succeeds', async () => {
  const t = mount()
  const out = await t.runCommand('set mode hook')
  assert.equal(out.kind, 'success')
  assert.match(out.text, /mode set to hook/)
})

test('/rtk help lists hook mode', async () => {
  const t = mount()
  const out = await t.runCommand('help')
  assert.equal(out.kind, 'success')
  assert.match(out.text, /hook/)
})

// ── Task 2: pre-execute hook branch ─────────────────────────────────────────

test('hook mode pre-execute spawns `rtk hook claude` with PreToolUse JSON stdin and plans the rewrite', async () => {
  const spawnLog = []
  const t = mount({
    spawnLog,
    spawnResult: {
      outcome: { exitCode: 0, signal: null },
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: { command: 'rtk ls -la' }
        }
      })
    }
  })
  await t.runCommand('set mode hook')
  const { out, nextCalled } = await pre(t, 'call-1', 'ls -la')
  assert.equal(nextCalled, true, 'pre-execute must allow (not deny)')
  assert.equal(out.kind, 'next')
  assert.equal(spawnLog.length, 1, 'exactly one spawn for the hook call')
  const spec = spawnLog[0].spec
  assert.deepEqual(spec.argv, ['/usr/local/bin/rtk', 'hook', 'claude'])
  assert.equal(typeof spec.stdio.stdin.data, 'string')
  const payload = JSON.parse(spec.stdio.stdin.data)
  assert.equal(payload.hook_event_name, 'PreToolUse')
  assert.equal(payload.tool_name, 'Bash')
  assert.equal(payload.tool_input.command, 'ls -la')
})

test('hook mode pre-execute plans nothing when rtk hook returns no rewrite (empty stdout)', async () => {
  const spawnLog = []
  const t = mount({ spawnLog, spawnResult: { outcome: { exitCode: 0, signal: null }, stdout: '' } })
  await t.runCommand('set mode hook')
  const { nextCalled } = await pre(t, 'call-2', 'echo hi')
  assert.equal(nextCalled, true)
  assert.equal(spawnLog.length, 1, 'hook was consulted once')
  // second pre-execute must not spawn again for the same call after execute consumed the plan:
  // (execute consumption is Task 3; here we only assert pre-execute allows)
})

test('hook mode pre-execute allows when rtk binary is missing', async () => {
  const spawnLog = []
  const t = mount({ spawnLog, probe: async () => { throw new Error('not found') } })
  await t.runCommand('set mode hook')
  const { out, nextCalled } = await pre(t, 'call-3', 'ls')
  assert.equal(nextCalled, true)
  assert.equal(spawnLog.length, 0, 'no hook spawn when rtk missing')
})

// ── Task 3: tools/execute short-circuit ─────────────────────────────────────

test('hook mode execute short-circuits with a foreground value running the rewritten command', async () => {
  const spawnLog = []
  const t = mount({
    spawnLog,
    spawnResult: (spec) => {
      if (spec.argv[1] === 'hook') {
        return { outcome: { exitCode: 0, signal: null }, stdout: JSON.stringify({ hookSpecificOutput: { updatedInput: { command: 'rtk ls -la' } } }) }
      }
      // the rewritten command execution
      return { outcome: { exitCode: 0, signal: null }, stdout: 'file1\nfile2\n', stderr: '' }
    }
  })
  await t.runCommand('set mode hook')
  await pre(t, 'call-exec-1', 'ls -la')
  const { out, nextCalled } = await exec(t, 'call-exec-1', 'ls -la')
  assert.equal(nextCalled, false, 'execute must short-circuit, not fall through to real bash')
  assert.equal(out.kind, undefined, 'short-circuit returns the value object directly')
  const value = out.value
  assert.equal(value.kind, 'foreground')
  assert.equal(value.exitCode, 0)
  assert.equal(value.stdout.text, 'file1\nfile2\n')
  // the rewritten command is run via bash -c
  const execSpawn = spawnLog.find((e) => e.spec.argv[1] === '-c')
  assert.ok(execSpawn, 'must spawn a shell for the rewritten command')
  assert.equal(execSpawn.spec.argv[0], '/bin/bash')
  assert.equal(execSpawn.spec.argv[2], 'rtk ls -la')
})

test('hook mode execute falls through to next() when no plan exists', async () => {
  const spawnLog = []
  const t = mount({ spawnLog })
  await t.runCommand('set mode hook')
  const { out, nextCalled } = await exec(t, 'call-no-plan', 'ls')
  assert.equal(nextCalled, true)
  assert.equal(out.kind, 'next')
  assert.equal(spawnLog.length, 0, 'no spawn when no plan')
})

test('hook mode execute falls through to next() when the rewritten spawn throws', async () => {
  const t = mount({
    spawnResult: (spec) => {
      if (spec.argv[1] === '-c') throw new Error('boom')
      return { outcome: { exitCode: 0, signal: null }, stdout: JSON.stringify({ hookSpecificOutput: { updatedInput: { command: 'rtk ls' } } }) }
    }
  })
  await t.runCommand('set mode hook')
  await pre(t, 'call-throw', 'ls')
  const { out, nextCalled } = await exec(t, 'call-throw', 'ls')
  assert.equal(nextCalled, true, 'spawn failure must fall through to original command')
  assert.equal(out.kind, 'next')
})

test('hook mode execute returns timedOut result (no fallthrough) when the rewritten spawn times out', async () => {
  const t = mount({
    spawnResult: (spec) => {
      if (spec.argv[1] === '-c') {
        return new Promise(() => {}) // never settles; timer fires first
      }
      return { outcome: { exitCode: 0, signal: null }, stdout: JSON.stringify({ hookSpecificOutput: { updatedInput: { command: 'rtk ls' } } }) }
    }
  })
  await t.runCommand('set mode hook')
  await pre(t, 'call-timeout', 'ls')
  const { out, nextCalled } = await exec(t, 'call-timeout', 'ls')
  assert.equal(nextCalled, false, 'timeout must NOT fall through (original may have run partially)')
  assert.equal(out.value.timedOut, true)
  assert.equal(out.value.exitCode, null)
})
