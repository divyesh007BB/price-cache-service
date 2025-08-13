// state.js
// Shared in-memory state between price server and order routes

module.exports = {
  priceCache: new Map(), // symbol -> { price, ts }
  WHITELIST: new Set()    // set of tradable symbols
};
