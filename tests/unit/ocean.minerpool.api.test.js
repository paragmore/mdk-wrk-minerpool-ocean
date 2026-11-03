'use strict'

const test = require('brittle')
const OceanMinerPoolApi = require('../../src/lib/ocean.minerpool.api')

test('OceanMinerPoolApi: should create instance with http client', (t) => {
  const mockHttp = {
    get: async () => ({ body: { result: {} } })
  }

  const api = new OceanMinerPoolApi(mockHttp)
  t.ok(api)
  t.ok(api._http === mockHttp)
})

test('OceanMinerPoolApi: getHashRateInfo should call correct endpoint', async (t) => {
  const username = 'testuser'
  let calledPath = null

  const mockHttp = {
    get: async (path) => {
      calledPath = path
      return { body: { result: { hashrate_60s: 1000 } } }
    }
  }

  const api = new OceanMinerPoolApi(mockHttp)
  const result = await api.getHashRateInfo(username)

  t.is(calledPath, `/v1/user_hashrate/${username}`)
  t.ok(result)
  t.is(result.hashrate_60s, 1000)
})

test('OceanMinerPoolApi: getWorkers should call correct endpoint', async (t) => {
  const username = 'testuser'
  let calledPath = null

  const mockHttp = {
    get: async (path) => {
      calledPath = path
      return { body: { result: { workers: {} } } }
    }
  }

  const api = new OceanMinerPoolApi(mockHttp)
  const result = await api.getWorkers(username)

  t.is(calledPath, `/v1/user_hashrate_full/${username}`)
  t.ok(result)
  t.ok(result.workers)
})

test('OceanMinerPoolApi: getMonthlyEarnings should call correct endpoint', async (t) => {
  const username = 'testuser'
  const month = '2024-1'
  let calledPath = null

  const mockHttp = {
    get: async (path) => {
      calledPath = path
      return { body: { result: { report: [] } } }
    }
  }

  const api = new OceanMinerPoolApi(mockHttp)
  const result = await api.getMonthlyEarnings(username, month)

  t.is(calledPath, `/v1/monthly_earnings_report/${username}/${month}`)
  t.ok(result)
  t.ok(result.report)
})

test('OceanMinerPoolApi: getTransactions should call correct endpoint', async (t) => {
  const username = 'testuser'
  const start = 1234567890
  const end = 1234654290
  let calledPath = null

  const mockHttp = {
    get: async (path) => {
      calledPath = path
      return { body: { result: { earnings: [] } } }
    }
  }

  const api = new OceanMinerPoolApi(mockHttp)
  const result = await api.getTransactions(username, start, end)

  t.is(calledPath, `/v1/earnpay/${username}/${start}/${end}`)
  t.ok(result)
})

test('OceanMinerPoolApi: getBlocks should call correct endpoint', async (t) => {
  let calledPath = null

  const mockHttp = {
    get: async (path) => {
      calledPath = path
      return { body: { result: { blocks: [] } } }
    }
  }

  const api = new OceanMinerPoolApi(mockHttp)
  const result = await api.getBlocks()

  t.is(calledPath, '/v1/blocks')
  t.ok(result)
  t.ok(result.blocks)
})

test('OceanMinerPoolApi: getEarnings should call correct endpoint', async (t) => {
  const username = 'testuser'
  const startTime = 1234567890
  let calledPath = null

  const mockHttp = {
    get: async (path) => {
      calledPath = path
      return { body: { result: { earnings: [] } } }
    }
  }

  const api = new OceanMinerPoolApi(mockHttp)
  const result = await api.getEarnings(username, startTime)

  t.is(calledPath, `/v1/earnpay/${username}/${startTime}`)
  t.ok(result)
})

test('OceanMinerPoolApi: getStatsSnap should call correct endpoint', async (t) => {
  const username = 'testuser'
  let calledPath = null

  const mockHttp = {
    get: async (path) => {
      calledPath = path
      return { body: { result: { unpaid: '0.1', estimated_total_earn_next_block: '0.2' } } }
    }
  }

  const api = new OceanMinerPoolApi(mockHttp)
  const result = await api.getStatsSnap(username)

  t.is(calledPath, `/v1/statsnap/${username}`)
  t.is(result.unpaid, '0.1')
})

test('OceanMinerPoolApi: spaces calls by rateLimitMs instead of sleeping before every call', async (t) => {
  const mockHttp = { get: async () => ({ body: { result: {} } }) }

  const unlimited = new OceanMinerPoolApi(mockHttp, { rateLimitMs: 0 })
  let started = Date.now()
  await unlimited.getBlocks()
  await unlimited.getBlocks()
  t.ok(Date.now() - started < 200, 'rateLimitMs 0 adds no delay')

  const spaced = new OceanMinerPoolApi(mockHttp, { rateLimitMs: 150 })
  started = Date.now()
  await spaced.getBlocks()
  const first = Date.now() - started
  await spaced.getBlocks()
  const both = Date.now() - started
  t.ok(first < 100, `first call goes out at once (${first}ms)`)
  t.ok(both >= 150, `second call waits for the window (${both}ms)`)
})
