'use strict'

const { setTimeout: sleep } = require('timers/promises')

const DEFAULT_RATE_LIMIT_MS = 1000

class OceanMinerPoolApi {
  constructor (http, { rateLimitMs = DEFAULT_RATE_LIMIT_MS } = {}) {
    this._http = http
    this._rateLimitMs = Number(rateLimitMs) >= 0 ? Number(rateLimitMs) : DEFAULT_RATE_LIMIT_MS
    this._lastCallAt = 0
  }

  // Ocean rate-limits its API: keep calls at least rateLimitMs apart, but
  // only wait for the remainder of that window, so a call that comes after a
  // quiet second (or the first call of a pull) goes out at once. 0 disables
  // the spacing, for a mock.
  async _throttle () {
    const wait = this._rateLimitMs - (Date.now() - this._lastCallAt)
    if (wait > 0) await sleep(wait)
    this._lastCallAt = Date.now()
  }

  async _request (apiPath) {
    await this._throttle()
    let resp
    try {
      const res = await this._http.get(apiPath, { encoding: 'json' })
      resp = res.body
    } catch (e) {
      const err = new Error('ERR_OCEAN_REQUEST_FAILED')
      err.cause = e
      throw err
    }
    if (!resp || resp.error || resp.result === undefined) {
      const err = new Error('ERR_OCEAN_API_ERROR')
      err.detail = resp && resp.error
      throw err
    }
    return resp.result
  }

  async getHashRateInfo (username) {
    return this._request(`/v1/user_hashrate/${username}`)
  }

  async getStatsSnap (username) {
    return this._request(`/v1/statsnap/${username}`)
  }

  async getWorkers (username) {
    return this._request(`/v1/user_hashrate_full/${username}`)
  }

  async getMonthlyEarnings (username, month) {
    return this._request(`/v1/monthly_earnings_report/${username}/${month}`)
  }

  async getTransactions (username, start, end) {
    return await this._request(`/v1/earnpay/${username}/${start}/${end}`)
  }

  async getBlocks () {
    return await this._request('/v1/blocks')
  }

  async getEarnings (username, startTime) {
    return await this._request(`/v1/earnpay/${username}/${startTime}`)
  }

  // Reachability probe that lets failures propagate, unlike `_request`.
  async ping () {
    await this._http.get('/v1/blocks', { encoding: 'json' })
    return true
  }
}

module.exports = OceanMinerPoolApi
