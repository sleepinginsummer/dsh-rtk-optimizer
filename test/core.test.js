'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const hostPath = path.join(__dirname, '..', 'src', 'host.js')
const hostBody = fs.readFileSync(hostPath, 'utf8')

test('host.js parses as a function body (DSH precheck parity)', () => {
  assert.doesNotThrow(() => new Function(`(async () => {\n${hostBody}\n})()`))
})

test('host.js evaluates to a plugin in a non-sandbox environment (static mount)', () => {
  const plugin = new Function(hostBody)()
  assert.equal(typeof plugin, 'object')
  assert.equal(typeof plugin.apply, 'function')
})

const PURE_START = '\n//PURE-CORE-START'
const PURE_END = '\n//PURE-CORE-END'
const startIdx = hostBody.indexOf(PURE_START)
const endIdx = hostBody.indexOf(PURE_END)
assert.ok(startIdx >= 0 && endIdx > startIdx, 'pure-core markers present')
const pureSection = hostBody.slice(startIdx + 1, endIdx + PURE_END.length)
const core = new Function(`${pureSection}\n; return rtkCore`)()

const {
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
} = core

// ── ANSI ──────────────────────────────────────────────────────────────────
test('stripAnsi removes CSI and OSC sequences', () => {
  const input = '\u001b[31mred\u001b[0m \u001b[1mbold\u001b[22m \u001b]0;title\u0007osc'
  assert.equal(stripAnsi(input), 'red bold osc')
  assert.equal(stripAnsi('plain'), 'plain')
})

// ── git compaction ────────────────────────────────────────────────────────
test('compactGitOutput summarizes git status --short and shortens hashes', () => {
  const input = [
    ' M src/a.js',
    ' M src/b.js',
    'A  new.txt',
    'D  old.txt',
    '?? untracked.txt',
    'commit 0123456789abcdef0123456789abcdef01234567 (HEAD -> main)',
    '    some message'
  ].join('\n')
  const out = compactGitOutput(input)
  assert.match(out, /\[git status summary: 5 path\(s\) — M 2, A 1, D 1, \?\? 1\]/)
  assert.match(out, /commit 0123456 \(HEAD -> main\)/)
  // plain lines pass through
  assert.ok(out.includes('some message'))
})

test('compactGitOutput passes through non-git output unchanged', () => {
  const input = 'hello\nworld\n'
  assert.equal(compactGitOutput(input), 'hello\nworld\n')
})

// ── search grouping ───────────────────────────────────────────────────────
test('groupSearchOutput groups grep rows by file', () => {
  const input = [
    'src/a.js:3:foo',
    'src/a.js:7:foo',
    'src/b.ts:1:bar',
    '  (no matches in ignored files)'
  ].join('\n')
  const out = groupSearchOutput(input)
  assert.match(out, /src\/a\.js \(2 matches\)/)
  assert.match(out, /src\/b\.ts \(1 match\)/)
  assert.match(out, /3: foo/)
  assert.ok(out.includes('(no matches in ignored files)'))
})

test('groupSearchOutput returns input unchanged when nothing groups', () => {
  const input = 'just a line\nanother one\n'
  assert.equal(groupSearchOutput(input), input)
})

// ── test aggregation ──────────────────────────────────────────────────────
test('aggregateTestOutput keeps the summary and failure lines', () => {
  const input = [
    'PASS src/a.test.js',
    'FAIL src/b.test.js',
    '  AssertionError: expected 1 to equal 2',
    'Tests: 12 passed, 1 failed',
    'Test Suites: 2 passed, 1 failed'
  ].join('\n')
  const out = aggregateTestOutput(input)
  assert.match(out, /\[test summary\] Tests: 12 passed, 1 failed/)
  assert.ok(out.includes('FAIL src/b.test.js'))
  assert.ok(out.includes('AssertionError'))
})

test('aggregateTestOutput leaves non-test output alone', () => {
  const input = 'ordinary shell output\nmore lines here\n'
  assert.equal(aggregateTestOutput(input), input)
})

// ── build filtering ───────────────────────────────────────────────────────
test('filterBuildOutput keeps error/warning lines and adds a summary', () => {
  const input = [
    'compiling...',
    'src/x.ts:12: error TS2322: Type mismatch',
    'src/y.ts:3: warning TS6133: unused',
    'done in 1.2s'
  ].join('\n')
  const out = filterBuildOutput(input)
  assert.ok(out.includes('error TS2322'))
  assert.ok(out.includes('warning TS6133'))
  assert.match(out, /\[build output filtered: kept 2 error\/warning line\(s\), dropped 2\]/)
})

test('filterBuildOutput passes through when nothing matches', () => {
  const input = 'all quiet\nnothing here\n'
  assert.equal(filterBuildOutput(input), input)
})

// ── truncation ────────────────────────────────────────────────────────────
test('truncateText keeps head, marker, and tail', () => {
  const input = 'x'.repeat(1000)
  const { text, truncated } = truncateText(input, 200, 0.4)
  assert.equal(truncated, true)
  assert.ok(text.length < 300)
  assert.ok(text.includes('output truncated by rtk-optimizer'))
  assert.ok(text.endsWith('x'.repeat(80)))
})

test('truncateText leaves short text untouched', () => {
  const { text, truncated } = truncateText('short', 200, 0.4)
  assert.equal(text, 'short')
  assert.equal(truncated, false)
})

// ── pipeline ──────────────────────────────────────────────────────────────
test('compactOutput strips ANSI and reports saved chars', () => {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG))
  const input = '\u001b[31mred\u001b[0m line\n'.repeat(5)
  const { text, savedChars } = compactOutput('bash', input, cfg)
  assert.ok(!text.includes('\u001b'))
  assert.ok(savedChars > 0)
  assert.equal(text, 'red line\n'.repeat(5))
})

test('compactOutput does not touch output when compaction disabled', () => {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG))
  cfg.outputCompaction.enabled = false
  const input = '\u001b[31mred\u001b[0m\n'
  const { text, savedChars } = compactOutput('bash', input, cfg)
  assert.equal(text, input)
  assert.equal(savedChars, 0)
})

test('compactOutput handles git status inside bash output', () => {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG))
  const input = ' M a.js\n M b.js\n?? c.js\n'
  const { text } = compactOutput('bash', input, cfg, 'git status --short')
  assert.match(text, /git status summary/)
})

test('compactOutput groups grep output', () => {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG))
  const input = 'a.txt:1:hi\na.txt:2:hi\nb.txt:1:yo\n'
  const { text } = compactOutput('grep', input, cfg)
  assert.match(text, /a\.txt \(2 matches\)/)
  assert.match(text, /b\.txt \(1 match\)/)
})

test('compactOutput read compaction is off by default', () => {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG))
  const input = 'a\n\n\n\nb\n'
  const { text } = compactOutput('read', input, cfg)
  assert.equal(text, input)
  // and on when enabled
  cfg.outputCompaction.readCompaction = true
  const { text: on } = compactOutput('read', input, cfg)
  assert.ok(on.length < input.length)
})

test('countSaved is the character delta', () => {
  assert.equal(countSaved('abcdef', 'abc'), 3)
  assert.equal(countSaved('ab', 'ab'), 0)
})

// ── plugin surface sanity ─────────────────────────────────────────────────
test('plugin registers pre-execute and post-execute listeners', () => {
  const plugin = new Function(hostBody)()
  const registered = []
  const ctx = {
    get: (name) => {
      if (name === 'timer') return { timeout: () => Promise.resolve() }
      return undefined
    },
    on: (event, listener) => { registered.push({ event, listener }) },
    provide: () => () => {}
  }
  plugin.apply(ctx)
  const events = registered.map((r) => r.event)
  assert.ok(events.includes('tools/pre-execute'))
  assert.ok(events.includes('tools/post-execute'))
})
