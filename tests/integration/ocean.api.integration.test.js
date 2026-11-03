'use strict'

const test = require('brittle')
const { createServer } = require('../../mock/server')
const OceanMinerPoolApi = require('../../src/lib/ocean.minerpool.api')
const { setTimeout: sleep } = require('timers/promises')

// Mock HTTP client that wraps fetch or http
class MockHttpClient {
  constructor (baseUrl) {
    this.baseUrl = baseUrl
  }

  async get (path, options = {}) {
    const url = `${this.baseUrl}${path}`
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      }
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const body = await response.json()
    // Server now returns { result: ... }, so we wrap it as { body: { result: ... } }
    // to match what bfx-facs-http returns
    return { body }
  }
}

let mockServer = null
let apiClient = null
let httpClient = null
const TEST_PORT = 8001
const TEST_HOST = '127.0.0.1'
const TEST_BASE_URL = `http://${TEST_HOST}:${TEST_PORT}`

// Helper function to wait for server to be ready
async function waitForServer (url, maxRetries = 20, delay = 200) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(`${url}/v1/ping`)
      if (response.ok) {
        return true
      }
    } catch (e) {
      // Server not ready yet
    }
    await sleep(delay)
  }
  throw new Error('Server failed to start')
}

// Initialize server once
async function ensureServer () {
  if (!mockServer) {
    mockServer = createServer({
      port: TEST_PORT,
      host: TEST_HOST,
      delay: 0,
      error: false
    })

    // Wait for server to be ready
    await waitForServer(TEST_BASE_URL, 20, 300)

    // Create HTTP client and API client
    httpClient = new MockHttpClient(TEST_BASE_URL)
    apiClient = new OceanMinerPoolApi(httpClient)
  }
  return { mockServer, apiClient, httpClient }
}

// Setup hook - runs before all tests
test('setup: start mock server', { hook: true }, async (t) => {
  await ensureServer()

  // Verify server is actually running
  const checkResponse = await fetch(`${TEST_BASE_URL}/v1/ping`)
  t.is(await checkResponse.text(), 'PONG', 'Server should respond to ping')

  // Teardown - stop server after all tests
  t.teardown(async () => {
    if (mockServer) {
      try {
        // Close the server and wait for it to fully close
        if (mockServer.app && mockServer.app.server) {
          await mockServer.stop()
          // Give the server a moment to fully close all connections
          await sleep(200)
        }
      } catch (e) {
        // Ignore errors during teardown, but try to force close
        try {
          if (mockServer.app && mockServer.app.server) {
            mockServer.app.server.close()
          }
        } catch (e2) {
          // Ignore
        }
      }
      mockServer = null
      apiClient = null
      httpClient = null
    }
  })

  t.pass('Mock server started and verified')
})

test('integration: should connect to mock server', async (t) => {
  await ensureServer()
  const response = await fetch(`${TEST_BASE_URL}/v1/ping`)
  const text = await response.text()
  t.is(text, 'PONG')
})

test('integration: getHashRateInfo should fetch user hashrate data', async (t) => {
  await ensureServer()
  const username = 'testuser'
  const result = await apiClient.getHashRateInfo(username)

  t.ok(result)
  t.ok(typeof result.snap_ts === 'number')
  t.ok(typeof result.hashrate_60s === 'number')
  t.ok(typeof result.hashrate_300s === 'number')
  t.ok(typeof result.hashrate_600s === 'number')
  t.ok(typeof result.hashrate_1800s === 'number')
  t.ok(typeof result.hashrate_3600s === 'number')
  t.ok(typeof result.hashrate_43200s === 'number')
  t.ok(typeof result.hashrate_86400s === 'number')
  t.ok(result.hashrate_60s > 0)
})

test('integration: getWorkers should fetch workers data', async (t) => {
  await ensureServer()
  const username = 'testuser'
  const result = await apiClient.getWorkers(username)

  t.ok(result)
  t.ok(typeof result.snap_ts === 'number')
  t.ok(result.workers)
  t.ok(typeof result.workers === 'object')
  t.ok(Object.keys(result.workers).length > 0)

  // Check worker structure
  const workerNames = Object.keys(result.workers)
  const firstWorker = result.workers[workerNames[0]]
  t.ok(Array.isArray(firstWorker))
  t.ok(firstWorker.length > 0)
  t.ok(typeof firstWorker[0].hashrate_60s === 'number')
  t.ok(typeof firstWorker[0].hashrate_3600s === 'number')
  t.ok(typeof firstWorker[0].hashrate_86400s === 'number')
})

test('integration: getMonthlyEarnings should fetch monthly earnings report', async (t) => {
  await ensureServer()
  const username = 'testuser'
  const currentMonth = new Date().toISOString().slice(0, 7) // YYYY-MM format
  const result = await apiClient.getMonthlyEarnings(username, currentMonth)

  t.ok(result)
  t.ok(result.report)
  t.ok(Array.isArray(result.report))
  t.ok(result.report.length > 0)

  // Check earnings structure
  const firstEarning = result.report[0]
  t.ok(firstEarning.TimeUTC)
  t.ok(typeof firstEarning.Blockheight === 'number')
  t.ok(typeof firstEarning.GrossUserRwd === 'number')
  t.ok(typeof firstEarning.NetUserRwd === 'number')
  t.ok(typeof firstEarning.UserHashSinceLastRwd === 'number')
  t.ok(typeof firstEarning.PoolHashSinceLastRwd === 'number')
})

test('integration: getTransactions should fetch earnings and payouts', async (t) => {
  await ensureServer()
  const username = 'testuser'
  const now = Math.floor(Date.now() / 1000)
  const start = now - (7 * 24 * 60 * 60) // 7 days ago
  const end = now

  const result = await apiClient.getTransactions(username, start, end)

  t.ok(result)
  t.ok(result.earnings !== undefined)
  t.ok(result.payouts !== undefined)
  t.ok(Array.isArray(result.earnings))
  t.ok(Array.isArray(result.payouts))
  // the mock seeds a block every two hours, so a week always has earnings
  t.ok(result.earnings.length > 0, `${result.earnings.length} earnings over 7 days`)

  // Check earnings structure if present
  if (result.earnings.length > 0) {
    const firstEarning = result.earnings[0]
    t.ok(firstEarning.block_hash)
    t.ok(typeof firstEarning.ts === 'number')
    // the pool fee is 2% of the user's share, so it is a small fraction of the payout
    t.ok(firstEarning.fees_collected_satoshis < firstEarning.satoshis_net_earned * 0.03,
      `fee ${firstEarning.fees_collected_satoshis} vs net ${firstEarning.satoshis_net_earned}`)
    t.ok(typeof firstEarning.satoshis_net_earned === 'number')
  }

  // Check payouts structure if present
  if (result.payouts.length > 0) {
    const firstPayout = result.payouts[0]
    t.ok(typeof firstPayout.ts === 'number')
    t.ok(firstPayout.on_chain_txid)
    t.ok(typeof firstPayout.total_satoshis_net_paid === 'number')
  }
})

test('integration: getBlocks should fetch blocks data', async (t) => {
  await ensureServer()
  const result = await apiClient.getBlocks()

  t.ok(result)
  t.ok(result.blocks)
  t.ok(Array.isArray(result.blocks))
  t.ok(result.blocks.length > 0)

  // Check block structure
  const firstBlock = result.blocks[0]
  t.ok(firstBlock.block_hash)
  t.ok(typeof firstBlock.ts === 'number')
  t.ok(typeof firstBlock.network_difficulty === 'number')
  t.ok(typeof firstBlock.accepted_shares === 'number')
  t.ok(typeof firstBlock.total_reward_sats === 'number')
  t.ok(typeof firstBlock.height === 'number')
  t.ok(firstBlock.network_difficulty > 0)
  t.ok(firstBlock.accepted_shares > 0)
})

test('integration: getEarnings should fetch earnings with start time', async (t) => {
  await ensureServer()
  const username = 'testuser'
  const startTime = Math.floor((Date.now() - (24 * 60 * 60 * 1000)) / 1000) // 24 hours ago

  const result = await apiClient.getEarnings(username, startTime)

  t.ok(result)
  t.ok(result.earnings !== undefined)
  t.ok(result.payouts !== undefined)
  t.ok(Array.isArray(result.earnings))
  t.ok(Array.isArray(result.payouts))

  // Check that earnings are within the time range
  if (result.earnings.length > 0) {
    result.earnings.forEach(earning => {
      t.ok(earning.ts >= startTime, 'Earning timestamp should be after start time')
    })
  }
})

test('integration: should handle multiple accounts', async (t) => {
  await ensureServer()
  const usernames = ['testuser', 'testuser2', 'testuser3']

  for (const username of usernames) {
    const hashrate = await apiClient.getHashRateInfo(username)
    t.ok(hashrate)
    t.ok(hashrate.hashrate_60s >= 0)

    const workers = await apiClient.getWorkers(username)
    t.ok(workers)
    t.ok(workers.workers)

    // Small delay to avoid rate limiting
    await sleep(100)
  }
})

test('integration: should handle different time ranges for transactions', async (t) => {
  await ensureServer()
  const username = 'testuser'
  const now = Math.floor(Date.now() / 1000)

  // Test 1 day range
  const oneDayAgo = now - (24 * 60 * 60)
  const result1 = await apiClient.getTransactions(username, oneDayAgo, now)
  t.ok(result1)
  t.ok(Array.isArray(result1.earnings))

  // Test 7 day range
  const sevenDaysAgo = now - (7 * 24 * 60 * 60)
  const result2 = await apiClient.getTransactions(username, sevenDaysAgo, now)
  t.ok(result2)
  t.ok(Array.isArray(result2.earnings))

  // Test 30 day range
  const thirtyDaysAgo = now - (30 * 24 * 60 * 60)
  const result3 = await apiClient.getTransactions(username, thirtyDaysAgo, now)
  t.ok(result3)
  t.ok(Array.isArray(result3.earnings))
})

test('integration: should handle different months for monthly earnings', async (t) => {
  await ensureServer()
  const username = 'testuser'
  const now = new Date()
  const currentYear = now.getFullYear()
  const currentMonth = now.getMonth() + 1

  // Test current month
  const currentMonthKey = `${currentYear}-${currentMonth}`
  const result1 = await apiClient.getMonthlyEarnings(username, currentMonthKey)
  t.ok(result1)
  t.ok(result1.report)
  t.ok(Array.isArray(result1.report))

  // Test previous month
  const prevMonth = currentMonth === 1 ? 12 : currentMonth - 1
  const prevYear = currentMonth === 1 ? currentYear - 1 : currentYear
  const prevMonthKey = `${prevYear}-${prevMonth}`
  const result2 = await apiClient.getMonthlyEarnings(username, prevMonthKey)
  t.ok(result2)
  t.ok(result2.report)
  t.ok(Array.isArray(result2.report))
})

test('integration: should validate data types and ranges', async (t) => {
  await ensureServer()
  const username = 'testuser'

  // Test hashrate values are positive numbers
  const hashrate = await apiClient.getHashRateInfo(username)
  t.ok(hashrate.hashrate_60s >= 0)
  t.ok(hashrate.hashrate_3600s >= 0)
  t.ok(hashrate.hashrate_86400s >= 0)

  // Test blocks have valid timestamps
  const blocksResult = await apiClient.getBlocks()
  blocksResult.blocks.forEach(block => {
    t.ok(block.ts > 0, 'Block timestamp should be positive')
    t.ok(block.network_difficulty > 0, 'Network difficulty should be positive')
    t.ok(block.accepted_shares > 0, 'Accepted shares should be positive')
    t.ok(block.total_reward_sats > 0, 'Total reward should be positive')
  })

  // Test workers have valid structure
  const workers = await apiClient.getWorkers(username)
  Object.values(workers.workers).forEach(workerArray => {
    t.ok(Array.isArray(workerArray))
    if (workerArray.length > 0) {
      const worker = workerArray[0]
      t.ok(typeof worker.hashrate_60s === 'number')
      t.ok(worker.hashrate_60s >= 0)
    }
  })
})

test('integration: should handle concurrent requests', async (t) => {
  await ensureServer()
  const username = 'testuser'

  // Make multiple concurrent requests
  const promises = [
    apiClient.getHashRateInfo(username),
    apiClient.getWorkers(username),
    apiClient.getBlocks(),
    apiClient.getHashRateInfo(username),
    apiClient.getWorkers(username)
  ]

  const results = await Promise.all(promises)

  t.is(results.length, 5)
  t.ok(results[0]) // hashrate
  t.ok(results[1]) // workers
  t.ok(results[2]) // blocks
  t.ok(results[3]) // hashrate
  t.ok(results[4]) // workers
})

test('integration: should read all required data fields', async (t) => {
  await ensureServer()
  const username = 'testuser'

  // Test all data reads
  const [hashrate, workers, blocks, transactions, monthlyEarnings] = await Promise.all([
    apiClient.getHashRateInfo(username),
    apiClient.getWorkers(username),
    apiClient.getBlocks(),
    apiClient.getTransactions(username, Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000), Math.floor(Date.now() / 1000)),
    apiClient.getMonthlyEarnings(username, new Date().toISOString().slice(0, 7))
  ])

  // Validate hashrate data
  t.ok(hashrate)
  t.ok('hashrate_60s' in hashrate)
  t.ok('hashrate_3600s' in hashrate)
  t.ok('hashrate_86400s' in hashrate)

  // Validate workers data
  t.ok(workers)
  t.ok('workers' in workers)
  t.ok('snap_ts' in workers)

  // Validate blocks data
  t.ok(blocks)
  t.ok(blocks.blocks)
  t.ok(Array.isArray(blocks.blocks))
  if (blocks.blocks.length > 0) {
    const block = blocks.blocks[0]
    t.ok('block_hash' in block)
    t.ok('ts' in block)
    t.ok('network_difficulty' in block)
    t.ok('accepted_shares' in block)
    t.ok('total_reward_sats' in block)
  }

  // Validate transactions data
  t.ok(transactions)
  t.ok('earnings' in transactions)
  t.ok('payouts' in transactions)

  // Validate monthly earnings data
  t.ok(monthlyEarnings)
  t.ok(monthlyEarnings.report)
  t.ok(Array.isArray(monthlyEarnings.report))
  if (monthlyEarnings.report.length > 0) {
    const earning = monthlyEarnings.report[0]
    t.ok('TimeUTC' in earning)
    t.ok('NetUserRwd' in earning)
  }
})

// Final cleanup hook to ensure server is closed
test('teardown: stop mock server', { hook: true }, async (t) => {
  if (mockServer) {
    try {
      if (mockServer.app && mockServer.app.server) {
        // Set a timeout to force close if it takes too long
        const stopPromise = mockServer.stop()
        const timeoutPromise = sleep(1000).then(() => {
          // Force close if still open
          if (mockServer && mockServer.app && mockServer.app.server) {
            try {
              mockServer.app.server.close(() => {})
            } catch (e) {
              // Ignore
            }
          }
        })
        await Promise.race([stopPromise, timeoutPromise])
      }
    } catch (e) {
      // Ignore errors, but try to force close
      try {
        if (mockServer && mockServer.app && mockServer.app.server) {
          mockServer.app.server.close(() => {})
        }
      } catch (e2) {
        // Ignore
      }
    }
    mockServer = null
    apiClient = null
    httpClient = null
  }
  t.pass('Mock server cleaned up')
})
