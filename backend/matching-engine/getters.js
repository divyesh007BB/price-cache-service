// backend/matching-engine/getters.js
let getOpenTrades = () => [];
let getAccounts = () => [];
let closeTrade = async () => {};

function registerGetters({ _getOpenTrades, _getAccounts, _closeTrade }) {
  if (_getOpenTrades) getOpenTrades = _getOpenTrades;
  if (_getAccounts) getAccounts = _getAccounts;
  if (_closeTrade) closeTrade = _closeTrade;
}

module.exports = {
  getOpenTrades: (...args) => getOpenTrades(...args),
  getAccounts: (...args) => getAccounts(...args),
  closeTrade: (...args) => closeTrade(...args),
  registerGetters,
};
