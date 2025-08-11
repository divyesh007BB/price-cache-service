function evaluateOpenPositions(symbol, tickPrice, openPositions) {
  openPositions.forEach((pos) => {
    if (pos.symbol !== symbol) return;

    // Stop Loss
    if (
      pos.stop_loss &&
      ((pos.side === 'BUY' && tickPrice <= pos.stop_loss) ||
        (pos.side === 'SELL' && tickPrice >= pos.stop_loss))
    ) {
      console.log(`🛑 SL hit for ${symbol} — close position`);
      // TODO: call Supabase to close
    }

    // Take Profit
    if (
      pos.take_profit &&
      ((pos.side === 'BUY' && tickPrice >= pos.take_profit) ||
        (pos.side === 'SELL' && tickPrice <= pos.take_profit))
    ) {
      console.log(`🎯 TP hit for ${symbol} — close position`);
      // TODO: call Supabase to close
    }
  });
}

module.exports = { evaluateOpenPositions };
