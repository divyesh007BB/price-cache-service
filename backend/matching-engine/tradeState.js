// tradeState.js — Shared trade/account state to avoid circular dependency

let openTrades = [];
let accounts = [];

/**
 * ===== Getters =====
 */
function getOpenTrades() {
  return openTrades;
}

function getAccounts() {
  return accounts;
}

/**
 * ===== Setters =====
 */
function setOpenTrades(trades) {
  openTrades = trades || [];
}

function setAccounts(accs) {
  accounts = accs || [];
}

/**
 * ===== Utility =====
 */
function addOpenTrade(trade) {
  openTrades.push(trade);
}

function removeOpenTrade(tradeId) {
  openTrades = openTrades.filter((t) => t.id !== tradeId);
}

function updateAccount(accountId, updated) {
  accounts = accounts.map((a) => (a.id === accountId ? { ...a, ...updated } : a));
  return accounts.find((a) => a.id === accountId);
}

module.exports = {
  getOpenTrades,
  getAccounts,
  setOpenTrades,
  setAccounts,
  addOpenTrade,
  removeOpenTrade,
  updateAccount,
};
