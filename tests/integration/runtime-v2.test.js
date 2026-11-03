'use strict'

const path = require('path')
const test = require('brittle')
const { createServer } = require('../../mock/server')
const WorkerRuntimeV2 = require('@tetherto/mdk/backend/core/mdk-worker/lib/worker-runtime-v2')
const { build } = require('@tetherto/mdk/backend/core/kernel/lib/protocol/envelope')
const { ACTIONS, MESSAGE_TYPES } = require('@tetherto/mdk/backend/core/kernel/lib/protocol/actions')

const WORKER_DIR = path.resolve(__dirname, '../..')

const request = (action, deviceId, payload = {}) => build({
  action,
  type: MESSAGE_TYPES.REQUEST,
  sender: 'runtime-v2-test',
  target: 'ocean-test',
  deviceId,
  payload
})

function freePort () {
  return new Promise((resolve, reject) => {
    const net = require('net')
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

test('WorkerRuntimeV2 serves ocean telemetry without credentials', async (t) => {
  const port = await freePort()
  const mock = createServer({ host: '127.0.0.1', port, delay: 0 })
  await mock.app.ready()

  const runtime = new WorkerRuntimeV2(WORKER_DIR, {
    workerId: 'ocean-test',
    // the runtime is fail-closed on newer MDK releases; nothing dials this test runtime
    allowAll: true,
    env: { DATUM_USER: 'datum-user', DATUM_PASSWORD: 'datum-secret' },
    devices: [{
      deviceId: 'pool-0',
      config: {
        apiUrl: `http://127.0.0.1:${port}`,
        datumApiUrl: `http://127.0.0.1:${port}`,
        accounts: ['test'],
        apiRetry: 1,
        apiRateLimitMs: 0
      }
    }]
  })
  t.teardown(async () => {
    await runtime.stop()
    await mock.stop()
  })
  await runtime.start()

  const identity = await runtime.handleRequest(request(ACTIONS.IDENTITY_REQUEST, null))
  t.is(identity.payload.workerId, 'ocean-test')
  t.is(identity.payload.devices[0].deviceId, 'pool-0')

  const capability = await runtime.handleRequest(request(ACTIONS.CAPABILITY_REQUEST, null))
  t.is(capability.payload.contract.metadata.provider, 'ocean')
  t.ok(capability.payload.contract.capabilities.telemetry.some((entry) => entry.name === 'health'))
  for (const entry of capability.payload.contract.capabilities.telemetry) {
    t.is(entry.handler, undefined, 'handler paths are stripped')
  }

  const hashrate = await runtime.handleRequest(request(ACTIONS.TELEMETRY_PULL, 'pool-0', {
    query: { type: 'hashrate' }
  }))
  t.is(hashrate.payload.name, 'hashrate')
  t.ok(hashrate.payload.value > 0)

  const health = await runtime.handleRequest(request(ACTIONS.TELEMETRY_PULL, 'pool-0', {
    query: { type: 'health' }
  }))
  const published = JSON.stringify(health.payload)
  t.absent(published.includes('datum-secret'))
  t.absent(published.includes('DATUM_PASSWORD'))
  t.ok(['OK', 'DEGRADED', 'OFFLINE'].includes(health.payload.value.status))

  const config = await runtime.handleRequest(request(ACTIONS.TELEMETRY_PULL, 'pool-0', {
    query: { type: 'datum_config' }
  }))
  t.absent(JSON.stringify(config.payload).includes('rpcpassword'))
  t.ok(config.payload.value.config.pool_address)

  const missing = await runtime.handleRequest(request(ACTIONS.TELEMETRY_PULL, 'pool-0', {
    query: { type: 'stats_history' }
  }))
  t.ok(/ERR_START_INVALID/.test(missing.payload.error))

  // transactions come from the pool for the whole range, not from the
  // in-memory history (which holds only what was recorded since start)
  const end = Date.now()
  const start = end - 7 * 24 * 60 * 60 * 1000
  const transactions = await runtime.handleRequest(request(ACTIONS.TELEMETRY_PULL, 'pool-0', {
    query: { type: 'transactions', start, end }
  }))
  const rows = transactions.payload.value
  // the mock seeds ten blocks two hours apart, so the range always holds rows
  t.ok(Array.isArray(rows) && rows.length >= 1, `${rows.length} daily rows over 7 days`)
  t.is(rows.reduce((n, row) => n + row.transactions.length, 0), 10, 'every seeded block earns once')
  t.ok(rows.every((row) => row.ts >= start - 24 * 60 * 60 * 1000 && row.ts <= end && Array.isArray(row.transactions)))
  t.ok(rows.every((row, i) => i === 0 || row.ts > rows[i - 1].ts), 'one row per day, ascending')
  t.ok(rows.every((row) => row.transactions.every((tx) => tx.username === 'test' && typeof tx.satoshis_net_earned === 'number')))

  const hourly = await runtime.handleRequest(request(ACTIONS.TELEMETRY_PULL, 'pool-0', {
    query: { type: 'transactions', start, end, aggrHourly: true }
  }))
  t.ok(hourly.payload.value.hourlyRevenues.length >= 7 * 24)

  const noRange = await runtime.handleRequest(request(ACTIONS.TELEMETRY_PULL, 'pool-0', {
    query: { type: 'transactions' }
  }))
  t.ok(/ERR_START_INVALID/.test(noRange.payload.error))
})
