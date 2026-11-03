'use strict'

const { setTimeout: sleep } = require('timers/promises')
const { opts, env, logger } = require('@tetherto/mdk-worker/device')
const OceanMinerPoolApi = require('./lib/ocean.minerpool.api')
const DatumApi = require('./lib/datum.minerpool.api')
const { buildAlerts } = require('./lib/alerts')
const {
  BTC_SATS,
  MINUTE_MS,
  HOURS_24_MS,
  POOL_TYPE,
  DATUM_STATUS,
  DATUM_OFFLINE_ERROR
} = require('./lib/constants')
const {
  getWorkersStats,
  getMonthlyDateRanges,
  isCurrentMonth,
  convertMsToSeconds,
  toNumberOrNull
} = require('./lib/utils')

const REQUEST_TIMEOUT_MS = 30 * 1000
const DEFAULT_RATE_LIMIT_MS = 1000

function httpClient (baseUrl) {
  return {
    baseUrl,
    async get (apiPath) {
      const url = apiPath.includes('://') ? apiPath : `${baseUrl}/${String(apiPath).replace(/^\//, '')}`
      const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      if (!response.ok) {
        const err = new Error(`ERR_HTTP_${response.status}`)
        err.status = response.status
        throw err
      }
      return { body: await response.json() }
    }
  }
}

class PoolClient {
  constructor () {
    const accounts = Array.isArray(opts.accounts) ? opts.accounts : []
    if (!opts.apiUrl) throw new Error('ERR_API_URL_REQUIRED')
    if (!accounts.length) throw new Error('ERR_ACCOUNTS_REQUIRED')

    this.apiUrl = opts.apiUrl
    this.accounts = accounts
    this.apiRetry = Number(opts.apiRetry) > 0 ? Number(opts.apiRetry) : 3
    this.rateLimitMs = Number(opts.apiRateLimitMs) >= 0 ? Number(opts.apiRateLimitMs) : DEFAULT_RATE_LIMIT_MS
    this.oceanApi = new OceanMinerPoolApi(httpClient(this.apiUrl), { rateLimitMs: this.rateLimitMs })
    this.datumApi = opts.datumApiUrl
      ? new DatumApi(httpClient(opts.datumApiUrl), {
        user: env.DATUM_USER,
        password: env.DATUM_PASSWORD
      })
      : null

    this.statsData = { ts: 0, stats: [] }
    this.workersData = { ts: 0, workers: [] }
    this.alertsData = { ts: 0, alerts: [] }
    this.alertsPrev = {}
    this.alertStatus = { datum: null, ocean: null }
    this.balanceByMonth = {}
    this.history = {
      stats: [],
      workers: [],
      'workers-count': [],
      transactions: [],
      blocks: [],
      'alerts-history': []
    }
    this._chain = Promise.resolve()
    this._refreshing = false
    this._pending = false
    this.ready = Promise.resolve()
    this._schedule()
    this._kick()
  }

  _schedule () {
    this._timer = setTimeout(() => {
      this._kick()
      this._schedule()
    }, MINUTE_MS)
    if (this._timer.unref) this._timer.unref()
  }

  _kick () {
    if (this._refreshing) {
      this._pending = true
      return
    }
    this._refreshing = true
    const run = this.refresh().catch((err) => logger('ERR_REFRESH %s', err.message))
    run.finally(() => {
      this._refreshing = false
      if (this._pending) {
        this._pending = false
        this._kick()
      }
    })
  }

  enqueue (fn) {
    const run = this._chain.then(fn, fn)
    this._chain = run.then(() => sleep(this.rateLimitMs), () => sleep(this.rateLimitMs))
    return run
  }

  // Earnings rows for a range, fetched from the pool in one call per account
  // rather than served from the in-memory history, which only holds what has
  // been recorded since the process started. Rows are grouped per local day,
  // the shape _refreshHistory() records, so aggregateTransactions() and
  // callers see the same rows either way.
  transactions (params) {
    requireRange(params)
    const start = Number(params.start)
    const end = Number(params.end)
    return this.enqueue(async () => {
      const byDay = new Map()
      for (const username of this.accounts) {
        const { earnings = [] } = await this.oceanApi.getTransactions(username, convertMsToSeconds(start), convertMsToSeconds(end))
        for (const row of earnings) {
          // earnpay rows carry a unix timestamp; the mock stamps them in ms
          const tsMs = row.ts > 1e12 ? row.ts : row.ts * 1000
          const day = new Date(tsMs).setHours(0, 0, 0, 0)
          if (!byDay.has(day)) byDay.set(day, { ts: day, transactions: [] })
          byDay.get(day).transactions.push({ username, ...row })
        }
      }
      return [...byDay.values()].sort((a, b) => a.ts - b.ts)
    })
  }

  async refresh () {
    this.ready = this.enqueue(() => this._refresh()).then(() => this.snapshot())
    return this.ready
  }

  async _refresh () {
    const now = Date.now()
    let workers = []
    for (const username of this.accounts) {
      try {
        workers = workers.concat(getWorkersStats(await this.oceanApi.getWorkers(username), username))
      } catch (err) {
        logger('ERR_WORKERS_FETCH %s %s', username, err.message)
      }
    }
    this.workersData = { ts: Math.floor(now / 1000) * 1000, workers }

    const stats = []
    for (const username of this.accounts) {
      stats.push(await this._accountStats(username))
    }
    this.statsData = { ts: this.workersData.ts, stats }
    this._remember('stats', { ts: this.statsData.ts, stats })
    this._remember('workers', { ts: this.workersData.ts, workers })
    this._remember('workers-count', { ts: this.workersData.ts, count: workers.length })
    await this._refreshHistory()
    await this._evaluateAlerts(now)
  }

  async _accountStats (username) {
    const earnings = await this._earnings(username)
    const hashRate = await this._hashrate(username)
    let snap = {}
    try {
      snap = await this.oceanApi.getStatsSnap(username) || {}
    } catch (err) {
      logger('ERR_STATSNAP %s %s', username, err.message)
    }
    return {
      username,
      timestamp: Date.now(),
      balance: toNumberOrNull(snap.unpaid),
      unsettled: earnings.unsettled,
      revenue_24h: earnings.revenue,
      estimated_today_income: earnings.income,
      estimated_earn_next_block: toNumberOrNull(snap.estimated_total_earn_next_block),
      hashrate: Number(hashRate.hashrate_60s) || 0,
      hashrate_1h: Number(hashRate.hashrate_3600s) || 0,
      hashrate_24h: Number(hashRate.hashrate_86400s) || 0,
      hashrate_stale_1h: 0,
      hashrate_stale_24h: 0,
      worker_count: this.workersData.workers.length,
      active_workers_count: hashRate.active_worker_count || 0,
      poolType: POOL_TYPE
    }
  }

  async _hashrate (username) {
    let last
    for (let attempt = 1; attempt <= this.apiRetry; attempt++) {
      try {
        const hashrate = await this.oceanApi.getHashRateInfo(username)
        if (hashrate && hashrate.hashrate_60s !== undefined) return hashrate
        last = new Error('ERR_HASHRATE_EMPTY')
      } catch (err) {
        last = err
      }
    }
    logger('ERR_HASHRATE %s %s', username, last && last.message)
    return {}
  }

  async _earnings (username) {
    let revenue = 0
    let income = 0
    try {
      const data = await this.oceanApi.getEarnings(username, convertMsToSeconds(Date.now() - HOURS_24_MS))
      for (const earning of data.earnings || []) revenue += earning.satoshis_net_earned
      for (const pay of data.payouts || []) income += pay.total_satoshis_net_paid
    } catch (err) {
      logger('ERR_EARNINGS %s %s', username, err.message)
    }
    return {
      revenue: revenue / BTC_SATS,
      income: income / BTC_SATS,
      unsettled: (revenue - income) / BTC_SATS
    }
  }

  async _refreshHistory () {
    const startMs = new Date().setHours(0, 0, 0, 0) - HOURS_24_MS
    const start = convertMsToSeconds(startMs)
    const end = convertMsToSeconds(startMs + HOURS_24_MS)
    const transactions = []
    for (const username of this.accounts) {
      try {
        const { earnings = [] } = await this.oceanApi.getTransactions(username, start, end)
        transactions.push(...earnings.map((row) => ({ username, ...row })))
      } catch (err) {
        logger('ERR_TRANSACTIONS %s %s', username, err.message)
      }
    }
    this._remember('transactions', { ts: startMs, transactions })

    try {
      const resp = await this.oceanApi.getBlocks()
      for (const block of (resp && resp.blocks) || []) {
        const ts = new Date(block.ts).getTime()
        this._remember('blocks', {
          ts,
          blockId: block.block_hash,
          networkDifficulty: block.network_difficulty,
          poolShares: block.accepted_shares,
          earnings: block.total_reward_sats / BTC_SATS,
          luck: block.network_difficulty / block.accepted_shares,
          luckEarnings100Percent: (block.total_reward_sats / BTC_SATS) / (block.network_difficulty / block.accepted_shares),
          username: block.username
        })
      }
    } catch (err) {
      logger('ERR_BLOCKS %s', err.message)
    }
  }

  async _evaluateAlerts (now) {
    const status = {
      datum: this.datumApi ? (await this.datumStats()).datum.status : null,
      ocean: await this.oceanStatus()
    }
    this.alertStatus = status
    const active = buildAlerts(status, this.alertsPrev, now)
    for (const alert of active) {
      if (!this.alertsPrev[alert.name]) this._remember('alerts-history', { ts: alert.createdAt, alerts: [alert] })
    }
    this.alertsPrev = Object.fromEntries(active.map((alert) => [alert.name, alert]))
    this.alertsData = { ts: now, alerts: active }
  }

  async oceanStatus () {
    try {
      await this.oceanApi.ping()
      return DATUM_STATUS.ONLINE
    } catch (err) {
      logger('ERR_OCEAN_REACHABILITY %s', err.message)
      return DATUM_STATUS.OFFLINE
    }
  }

  async datumStats () {
    if (!this.datumApi) {
      return { datum: { poolType: POOL_TYPE, status: null, error: null, connections: null, hashrate: null } }
    }
    try {
      const data = await this.datumApi.getStratumServerInfo()
      const info = (data && data.result) || data || {}
      return {
        datum: {
          poolType: POOL_TYPE,
          status: DATUM_STATUS.ONLINE,
          error: null,
          connections: info.totalConnections != null ? Number(info.totalConnections) : null,
          hashrate: info.estimatedHashrate != null ? Number(info.estimatedHashrate) : null
        }
      }
    } catch (err) {
      logger('ERR_DATUM_STATS %s', err.message)
      return {
        datum: {
          poolType: POOL_TYPE,
          status: DATUM_STATUS.OFFLINE,
          error: DATUM_OFFLINE_ERROR,
          connections: 0,
          hashrate: 0
        }
      }
    }
  }

  async datumCall (method, code) {
    if (!this.datumApi) throw new Error('ERR_DATUM_NOT_CONFIGURED')
    try {
      return await this.datumApi[method]()
    } catch (err) {
      if (String(err.message).startsWith('ERR_DATUM_')) throw err
      logger('%s %s', code, err.message)
      throw new Error(code)
    }
  }

  datumConfig () {
    return this.datumCall('getConfiguration', 'ERR_CONFIGURATION_FETCH').then(redactDatumConfig)
  }

  async yearlyBalances (username) {
    const ranges = getMonthlyDateRanges(12)
    const balances = this.balanceByMonth[username] || {}
    for (const [month, { key }] of Object.entries(ranges)) {
      if (balances[month] != null && !isCurrentMonth(month)) continue
      try {
        const earnings = await this.oceanApi.getMonthlyEarnings(username, key)
        balances[month] = (earnings.report || []).reduce((sum, row) => sum + Number(row.NetUserRwd), 0) / BTC_SATS
      } catch (err) {
        logger('ERR_BALANCES_FETCH %s', err.message)
        balances[month] = 0
      }
    }
    this.balanceByMonth[username] = balances
    return Object.entries(balances).map(([month, balance]) => ({ month, balance }))
  }

  _remember (key, entry) {
    const rows = this.history[key]
    const idx = rows.findIndex((row) => row.ts === entry.ts && row.blockId === entry.blockId)
    if (idx >= 0) rows[idx] = entry
    else rows.push(entry)
    const cap = key === 'blocks' ? 2000 : 1440
    if (rows.length > cap) rows.splice(0, rows.length - cap)
  }

  range (key, params) {
    requireRange(params)
    return this.history[key]
      .filter((row) => row.ts >= params.start && row.ts <= params.end)
      .sort((a, b) => a.ts - b.ts)
  }

  snapshot () {
    return {
      stats: this.statsData.stats,
      workers: this.workersData.workers,
      alerts: this.alertsData.alerts,
      status: this.alertStatus
    }
  }
}

function requireRange (params) {
  if (!params || params.start == null) throw new Error('ERR_START_INVALID')
  if (params.end == null) throw new Error('ERR_END_INVALID')
  if (!Number.isFinite(Number(params.start)) || !Number.isFinite(Number(params.end))) {
    throw new Error('ERR_RANGE_INVALID')
  }
}

let client

function getClient () {
  if (!client) client = new PoolClient()
  return client
}

module.exports = {
  getClient,
  requireRange,
  PoolClient
}

const DATUM_SECRET_KEYS = new Set(['rpcuser', 'rpcpassword', 'rpcpass', 'password', 'pass', 'token', 'secret'])

function redactDatumConfig (body) {
  const source = body && body.result ? body.result : body
  if (!source || typeof source !== 'object') return {}
  const config = {}
  for (const [key, value] of Object.entries(source)) {
    if (DATUM_SECRET_KEYS.has(String(key).toLowerCase())) continue
    config[key] = value
  }
  return { config }
}
