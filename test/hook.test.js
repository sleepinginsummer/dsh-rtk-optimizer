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
    // Optional spill-path fakes so readStream's spillPath propagation can be tested.
    const stdoutSpill = r?.stdoutSpill
    const stderrSpill = r?.stderrSpill
    const terminated = { terminated: false }
    return {
      done: Promise.resolve(outcome),
      terminate: () => { terminated.terminated = true },
      collected: {
        stdout: { readFrom: async () => ({ text: stdoutText, nextOffset: stdoutText.length, lossy: false, ...(stdoutSpill !== undefined ? { spillPath: stdoutSpill } : {}) }) },
        stderr: { readFrom: async () => ({ text: stderrText, nextOffset: stderrText.length, lossy: false, ...(stderrSpill !== undefined ? { spillPath: stderrSpill } : {}) }) }
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
      if (name === 'fs' && opts.fs) return opts.fs
      return undefined
    },
    on: (event, fn) => { handlers[event] = fn },
    provide: () => () => {}
  }
  plugin.apply(ctx, opts.injected)
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
  assert.match(out.text, /mode=hook/)
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

// ── Task 4: post-execute hook note ──────────────────────────────────────────

test('hook mode post-execute prefixes the executed-as note only in debug mode', async () => {
  const t = mount({
    spawnResult: (spec) => {
      if (spec.argv[1] === 'hook') {
        return { outcome: { exitCode: 0, signal: null }, stdout: JSON.stringify({ hookSpecificOutput: { updatedInput: { command: 'rtk ls -la' } } }) }
      }
      return { outcome: { exitCode: 0, signal: null }, stdout: 'file1\n', stderr: '' }
    }
  })
  await t.runCommand('set mode hook')
  await t.runCommand('set debug true')
  await pre(t, 'call-note-1', 'ls -la')
  await exec(t, 'call-note-1', 'ls -la')
  const result = {
    isError: false,
    content: [{ type: 'text', text: 'file1\n' }]
  }
  const { out, nextCalled } = await post(t, 'call-note-1', result)
  assert.equal(nextCalled, false, 'post-execute must accept with the note attached')
  assert.ok(out.content, 'post-execute returns accepted content')
  const texts = out.content.filter((b) => b.type === 'text').map((b) => b.text)
  assert.ok(texts.some((text) => text.includes('[rtk-optimizer] hook: executed as "rtk ls -la"')),
    'note must be attached in debug mode')
  assert.ok(texts[0].includes('[rtk-optimizer]'), 'note must be the first text block')
})

test('hook mode post-execute attaches no note by default (invisible hook)', async () => {
  const t = mount({
    spawnResult: (spec) => {
      if (spec.argv[1] === 'hook') {
        return { outcome: { exitCode: 0, signal: null }, stdout: JSON.stringify({ hookSpecificOutput: { updatedInput: { command: 'rtk ls -la' } } }) }
      }
      return { outcome: { exitCode: 0, signal: null }, stdout: 'file1\n', stderr: '' }
    }
  })
  await t.runCommand('set mode hook')
  await pre(t, 'call-note-0', 'ls -la')
  await exec(t, 'call-note-0', 'ls -la')
  const result = { isError: false, content: [{ type: 'text', text: 'file1\n' }] }
  const { out, nextCalled } = await post(t, 'call-note-0', result)
  assert.equal(nextCalled, true, 'no note in default mode → fall through unchanged (compaction had nothing to do)')
  assert.equal(out.kind, 'next')
})

test('hook mode post-execute attaches no note when the command was not replaced', async () => {
  const t = mount()
  await t.runCommand('set mode hook')
  const result = { isError: false, content: [{ type: 'text', text: 'plain output\n' }] }
  const { out, nextCalled } = await post(t, 'call-note-2', result)
  assert.equal(nextCalled, true, 'no note, no compaction → fall through unchanged')
  assert.equal(out.kind, 'next')
})

// ── Final review fixes: F1 (bounded maps) ───────────────────────────────────

test('hook mode bounded maps: hookPlan evicts oldest beyond 64 distinct plans', async () => {
  const t = mount({
    spawnResult: (spec) => {
      if (spec.argv[1] === 'hook') {
        return { outcome: { exitCode: 0, signal: null }, stdout: JSON.stringify({ hookSpecificOutput: { updatedInput: { command: 'rtk rewrite' } } }) }
      }
      // rewritten command execution
      return { outcome: { exitCode: 0, signal: null }, stdout: 'ok\n', stderr: '' }
    }
  })
  await t.runCommand('set mode hook')
  // Plan 65 distinct commands (65 hookPlan entries). Only the first is kept;
  // entry `call-cap-0` is the oldest and must be evicted.
  for (let i = 0; i < 65; i++) {
    const { nextCalled } = await pre(t, `call-cap-${i}`, `echo ${i}`)
    assert.equal(nextCalled, true, `pre must allow call-cap-${i}`)
  }
  // The oldest plan was evicted → execute falls through to next() (no plan).
  const oldestFirst = await exec(t, 'call-cap-0', 'echo 0')
  assert.equal(oldestFirst.nextCalled, true, 'oldest plan must be evicted by the cap')
  assert.equal(oldestFirst.out.kind, 'next')
  // A more recent plan survives → execute short-circuits.
  const newest = await exec(t, 'call-cap-63', 'echo 63')
  assert.equal(newest.nextCalled, false, 'a plan within the cap must survive')
  assert.equal(newest.out.value.kind, 'foreground')
})

test('hook mode bounded maps: hookExecuted evicts oldest beyond 64 so its post-execute note is dropped', async () => {
  const t = mount({
    spawnResult: (spec) => {
      if (spec.argv[1] === 'hook') {
        return { outcome: { exitCode: 0, signal: null }, stdout: JSON.stringify({ hookSpecificOutput: { updatedInput: { command: 'rtk rewrite' } } }) }
      }
      return { outcome: { exitCode: 0, signal: null }, stdout: 'ok\n', stderr: '' }
    }
  })
  await t.runCommand('set mode hook')
  await t.runCommand('set debug true')
  // Fully execute 65 distinct commands so hookExecuted grows to 65 and evicts
  // the oldest call-e-0 entry.
  for (let i = 0; i < 65; i++) {
    await pre(t, `call-e-${i}`, `echo ${i}`)
    await exec(t, `call-e-${i}`, `echo ${i}`)
  }
  // call-e-0 was executed but its hookExecuted entry was evicted → post-execute
  // attaches no note and falls through (nextCalled true).
  const result = { isError: false, content: [{ type: 'text', text: 'ok\n' }] }
  const { out, nextCalled } = await post(t, 'call-e-0', result)
  assert.equal(nextCalled, true, 'evicted executed-entry must drop the hook note')
  assert.equal(out.kind, 'next')
  // The newest entry (call-e-64) is within the cap → its note must still attach
  // in debug mode, proving eviction targets the oldest, not everything.
  const { out: outNewest, nextCalled: ncNewest } = await post(t, 'call-e-64', result)
  assert.equal(ncNewest, false, 'newest executed-entry must keep its note in debug mode')
  const texts = outNewest.content.filter((b) => b.type === 'text').map((b) => b.text)
  assert.ok(texts.some((text) => text.includes('[rtk-optimizer] hook: executed as "rtk rewrite"')),
    'newest note must attach in debug mode')
})

test('hook mode post-execute clears a planned-but-not-executed hookPlan entry', async () => {
  const t = mount({
    spawnResult: (spec) => {
      if (spec.argv[1] === 'hook') {
        return { outcome: { exitCode: 0, signal: null }, stdout: JSON.stringify({ hookSpecificOutput: { updatedInput: { command: 'rtk rewrite' } } }) }
      }
      return { outcome: { exitCode: 0, signal: null }, stdout: 'ok\n', stderr: '' }
    }
  })
  await t.runCommand('set mode hook')
  // pre-execute plans the rewrite but execute never runs (downstream deny /
  // scheduling error). post-execute must still clean the hookPlan entry so it
  // does not leak.
  await pre(t, 'call-cleaned', 'echo hi')
  const result = { isError: true, content: [] }
  const { nextCalled } = await post(t, 'call-cleaned', result)
  assert.equal(nextCalled, true, 'post-execute itself has nothing to do')
  // The plan was cleaned: re-running pre must re-plan (proving no stale entry)
  // and, more directly, execute must fall through (plan was removed).
  const { out, nextCalled: execNC } = await exec(t, 'call-cleaned', 'echo hi')
  assert.equal(execNC, true, 'planned-but-not-executed entry cleaned by post-execute')
  assert.equal(out.kind, 'next')
})

// ── Final review fixes: F2 (spillPath propagation) ──────────────────────────

test('hook mode execute propagates spillPath from the rewritten stdout/stderr streams', async () => {
  const t = mount({
    spawnResult: (spec) => {
      if (spec.argv[1] === 'hook') {
        return { outcome: { exitCode: 0, signal: null }, stdout: JSON.stringify({ hookSpecificOutput: { updatedInput: { command: 'rtk ls big' } } }) }
      }
      // rewritten command execution spills both streams
      return {
        outcome: { exitCode: 0, signal: null },
        stdout: 'big output\n',
        stdoutSpill: '/tmp/spilled-stdout.log',
        stderr: 'err\n',
        stderrSpill: '/tmp/spilled-stderr.log'
      }
    }
  })
  await t.runCommand('set mode hook')
  await pre(t, 'call-spill', 'ls big')
  const { out, nextCalled } = await exec(t, 'call-spill', 'ls big')
  assert.equal(nextCalled, false, 'execute must short-circuit')
  assert.equal(out.value.stdout.text, 'big output\n')
  assert.equal(out.value.stdout.spillPath, '/tmp/spilled-stdout.log', 'stdout spillPath must propagate')
  assert.equal(out.value.stderr.spillPath, '/tmp/spilled-stderr.log', 'stderr spillPath must propagate')
})

// ── Config persistence (cordis.patch.yml) ────────────────────────────────────

/** In-memory fake of ctx.fs backed by a single string "file". */
function makeFakeFs(initial = '') {
  let content = initial
  return {
    content: () => content,
    resolve: async (path) => ({ displayPath: path, targetKey: `fake:${path}` }),
    readText: async () => { if (content === '__MISSING__') throw new Error('ENOENT'); return content },
    writeText: async (target, text) => { content = text; return { version: 1 } }
  }
}

test('injected config merges over DEFAULT_CONFIG (persisted mode applies at apply time)', async () => {
  const t = mount({ injected: { mode: 'hook' } })
  const out = await t.runCommand('show')
  assert.equal(out.kind, 'success')
  assert.match(out.text, /mode: hook/, 'injected mode applies at apply time')
  // DEFAULT values still hold for keys not injected
  assert.match(out.text, /enabled: true/)
})

test('/rtk set persists mode into the patch file via ctx.fs (key added to existing block)', async () => {
  const fs = makeFakeFs('- id: dsh-rtk-optimizer\n  name: dsh-rtk-optimizer\n- id: token-panel\n  name: dsh-token-panel\n')
  const t = mount({ fs, injected: { persistFile: '/tmp/fake-patch.yml' } })
  const out = await t.runCommand('set mode hook')
  assert.equal(out.kind, 'success')
  assert.ok(!out.text.includes('not persisted'), 'set must persist when fs is available')
  const text = fs.content()
  assert.ok(text.includes('- id: dsh-rtk-optimizer'), 'block kept')
  assert.match(text, /config:\n\s+mode: "hook"/, 'mode added under config:')
  assert.ok(text.includes('- id: token-panel'), 'other entries untouched')
})

test('/rtk set updates an existing persisted key in place (no duplicate)', async () => {
  const fs = makeFakeFs('- id: dsh-rtk-optimizer\n  config:\n    mode: "suggest"\n- id: token-panel\n')
  const t = mount({ fs, injected: { persistFile: '/tmp/fake-patch.yml' } })
  await t.runCommand('set mode hook')
  const text = fs.content()
  const matches = text.match(/mode: "hook"/g) ?? []
  assert.equal(matches.length, 1, 'exactly one mode key, updated in place')
  assert.ok(!/mode: "suggest"/.test(text), 'old value replaced')
})

test('/rtk set appends a new id-targeted block when the patch has no entry yet', async () => {
  const fs = makeFakeFs('- id: token-panel\n  name: dsh-token-panel\n')
  const t = mount({ fs, injected: { persistFile: '/tmp/fake-patch.yml' } })
  await t.runCommand('set debug true')
  const text = fs.content()
  assert.ok(text.includes('- id: dsh-rtk-optimizer'), 'block appended')
  assert.match(text, /debug: true/, 'key present')
  assert.ok(text.includes('- id: token-panel'), 'existing entry kept')
})

test('persist failure degrades to in-memory-only (success response with not persisted)', async () => {
  const fs = makeFakeFs()
  fs.writeText = async () => { throw new Error('write denied') }
  const t = mount({ fs, injected: { persistFile: '/tmp/fake-patch.yml' } })
  const out = await t.runCommand('set mode hook')
  assert.equal(out.kind, 'success')
  assert.ok(out.text.includes('(not persisted)'), 'command still succeeds, warns not persisted')
})
