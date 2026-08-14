'use strict'

// Static DSH plugin entry point.
//
// src/host.js is a self-contained JavaScript FUNCTION BODY (DSH evaluates it
// as `(async () => { <body> })()` in the dynamic-plugin sandbox). This wrapper
// evaluates the same body inside a plain Node module, so the exact same source
// runs both as a dynamic plugin (cordis_define code.host) and as a statically
// mounted one (cordis.patch.yml row). This plugin registers no model tools, so
// no harness/staticTool adapter is needed — the body only uses ctx services.

const fs = require('node:fs')
const path = require('node:path')

const body = fs.readFileSync(path.join(__dirname, 'src', 'host.js'), 'utf8')
const plugin = new Function(body)()

module.exports = plugin
