'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const hostPath = path.join(__dirname, '..', 'src', 'host.js')
const hostBody = fs.readFileSync(hostPath, 'utf8')

/**
 * Mount the plugin against a fake ctx and capture the registered /rtk command
 * handler. `probe` is the fake subprocess.resolveExecutable implementation.
 */
function mount(probe) {
  let handler
  let probeCount = 0
  const plugin = new Function(hostBody)()
  const ctx = {
    get: (name) => {
      if (name === 'subprocess') return {
        resolveExecutable: async (...args) => {
          probeCount++
          return probe(...args)
        },
        spawn: () => { throw new Error('spawn not expected in command tests') }
      }
      if (name === 'timer') return { timeout: () => Promise.resolve() }
      if (name === 'commands') return {
        register: (def) => { handler = def.handler }
      }
      return undefined
    },
    on: () => {},
    provide: () => () => {}
  }
  plugin.apply(ctx)
  assert.ok(handler, 'rtk command must be registered')
  return {
    handler,
    run: (rawInput) => handler({ rawInput }),
    probeCount: () => probeCount
  }
}

test('/rtk verify probes the rtk binary and reports the resolved path', async () => {
  const t = mount(async () => '/home/yjw/.local/bin/rtk')
  const out = await t.run('verify')
  assert.equal(out.kind, 'success')
  assert.equal(t.probeCount(), 1, 'verify must actually probe, not read a stale cache')
  assert.match(out.text, /\/home\/yjw\/\.local\/bin\/rtk/)
})

test('/rtk verify reports NOT FOUND when the probe fails', async () => {
  const t = mount(async () => { throw new Error('rtk was not found on PATH') })
  const out = await t.run('verify')
  assert.equal(out.kind, 'success')
  assert.equal(t.probeCount(), 1)
  assert.match(out.text, /NOT FOUND/)
})

test('/rtk show triggers a probe and reports the resolved path instead of "not probed yet"', async () => {
  const t = mount(async () => '/home/yjw/.local/bin/rtk')
  const out = await t.run('show')
  assert.equal(out.kind, 'success')
  assert.equal(t.probeCount(), 1, 'show must probe so the status is truthful')
  assert.match(out.text, /rtk binary: \/home\/yjw\/\.local\/bin\/rtk/)
  assert.ok(!out.text.includes('not probed yet'))
})

test('/rtk verify reports NOT FOUND even on a second call (fresh probe, no stale cache)', async () => {
  let found = false
  const t = mount(async () => {
    if (!found) throw new Error('not found on PATH')
    return '/home/yjw/.local/bin/rtk'
  })
  const first = await t.run('verify')
  assert.match(first.text, /NOT FOUND/)
  found = true // user installs rtk now
  const second = await t.run('verify')
  assert.equal(t.probeCount(), 2, 'verify must re-probe on every invocation')
  assert.match(second.text, /\/home\/yjw\/\.local\/bin\/rtk/)
})

test('/rtk help still lists verify', async () => {
  const t = mount(async () => '/home/yjw/.local/bin/rtk')
  const out = await t.run('help')
  assert.equal(out.kind, 'success')
  assert.match(out.text, /verify/)
})
