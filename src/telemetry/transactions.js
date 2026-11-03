'use strict'

const { getClient } = require('../client')
const { aggregateTransactions } = require('../history')

module.exports = async (params = {}) => {
  const client = getClient()
  await client.ready
  const rows = await client.transactions(params)
  return params.aggrHourly ? aggregateTransactions(rows, params) : rows
}
