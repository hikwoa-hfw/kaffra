/**
 * fibonacci.js
 * Fibonacci retracement + RSI (5m entry timing, 1h trend confirmation)
 * Context: Detect dips before a re-pump, confluence signals for LLM
 */

/** Standard Fibonacci levels monitored */
const FIB_LEVELS = [
  { label: 'fib_0',   ratio: 0 },       // ATH / swing high
  { label: 'fib_236', ratio: 0.236 },
  { label: 'fib_382', ratio: 0.382 },
  { label: 'fib_50',  ratio: 0.5 },
  { label: 'fib_618', ratio: 0.618 },   // Golden ratio — strongest rebound zone
  { label: 'fib_786', ratio: 0.786 },   // Deep retracement — often a dip bottom
  { label: 'fib_100', ratio: 1 },       // Swing low
];

/**
 * Calculate all Fibonacci price levels from high to low.
 * Formula: high - (ratio × (high - low))
 */
function calcFibLevels(high, low) {
  const range = high - low;
  return FIB_LEVELS.map(({ label, ratio }) => ({
    label,
    ratio,
    price: parseFloat((high - ratio * range).toFixed(12)),
  }));
}

/**
 * Determine which Fibonacci zone the current price is in.
 * Zone = range between two Fibonacci levels bounding the price.
 *
 * @returns {{ zone, upperFib, lowerFib, positionInZonePct }}
 */
function classifyZone(currentPrice, levels) {
  // levels are sorted from high (fib_0) to low (fib_100)
  for (let i = 0; i < levels.length - 1; i++) {
    const upper = levels[i];
    const lower = levels[i + 1];
    if (currentPrice <= upper.price && currentPrice >= lower.price) {
      const zoneRange = upper.price - lower.price;
      const positionInZonePct = zoneRange > 0
        ? parseFloat(((upper.price - currentPrice) / zoneRange * 100).toFixed(2))
        : 0;
      return {
        zone:               `${upper.label}-${lower.label}`,
        upperFib:           upper.label,
        lowerFib:           lower.label,
        positionInZonePct,  // 0% = exactly at upper, 100% = exactly at lower
      };
    }
  }

  // Outside the range (above ATH or below swing low)
  if (currentPrice > levels[0].price)     return { zone: 'above_ath',       upperFib: null,      lowerFib: 'fib_0',  positionInZonePct: null };
  if (currentPrice < levels.at(-1).price) return { zone: 'below_swing_low', upperFib: 'fib_100', lowerFib: null,     positionInZonePct: null };
  return { zone: 'unknown', upperFib: null, lowerFib: null, positionInZonePct: null };
}

/**
 * Classify entry signals based on fib zones.
 * Adjusted for post-graduation degen memecoin context.
 * Zone separator uses '-' (plain hyphen) to avoid encoding mismatch.
 */
function dipSignal(zone) {
  const signals = {
    'fib_618-fib_786': { signal: 'strong_dip',    label: 'Golden dip zone - ideal entry for bounce' },
    'fib_786-fib_100': { signal: 'deep_dip',      label: 'Deep retracement - high risk, high reward' },
    'fib_50-fib_618':  { signal: 'moderate_dip',   label: 'Healthy pullback - can enter with BSR confirmation' },
    'fib_382-fib_50':  { signal: 'shallow_dip',    label: 'Shallow correction - low selling pressure' },
    'fib_236-fib_382': { signal: 'minor_pullback',  label: 'Minor pullback - price remains strong' },
    'fib_0-fib_236':   { signal: 'near_ath',        label: 'Near ATH - not a dip zone, avoid chasing' },
    'above_ath':       { signal: 'breakout',        label: 'Price discovery - above previous ATH' },
    'below_swing_low': { signal: 'danger',          label: 'Below swing low - possible further dump' },
  };
  return signals[zone] ?? { signal: 'unknown', label: 'Undefined zone' };
}

// ─── RSI ──────────────────────────────────────────────────────────────────────

/**
 * Calculate standard Wilder's RSI (14 period).
 * Input: array of close prices sorted ascending. Returns null if insufficient data.
 */
function calcRSI(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  const changes = [];
  for (let i = 1; i < closes.length; i++) changes.push(closes[i] - closes[i - 1]);

  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss += Math.abs(changes[i]);
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period; i < changes.length; i++) {
    const gain = changes[i] > 0 ? changes[i] : 0;
    const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  return parseFloat((100 - 100 / (1 + avgGain / avgLoss)).toFixed(2));
}

/**
 * Classify RSI into actionable zones.
 * Thresholds adjusted for degen memecoins — more extreme than standard stocks.
 */
function classifyRSI(rsi) {
  if (rsi === null) return { zone: 'unavailable',       label: 'Insufficient data' };
  if (rsi <= 25)    return { zone: 'oversold',          label: 'Extreme oversold - reversal imminent, ideal entry' };
  if (rsi <= 35)    return { zone: 'oversold_moderate', label: 'Oversold - selling pressure weakening, ready to accumulate' };
  if (rsi <= 50)    return { zone: 'neutral_bearish',   label: 'Neutral bearish - wait for confirmation' };
  if (rsi <= 60)    return { zone: 'neutral_bullish',   label: 'Neutral bullish - improving momentum' };
  if (rsi <= 75)    return { zone: 'bullish',           label: 'Bullish - strong momentum, watch for overbought' };
  if (rsi <= 85)    return { zone: 'overbought',        label: 'Overbought - do not chase, wait for pullback' };
  return              { zone: 'overbought_extreme', label: 'Extreme overbought - pump might be late' };
}

/**
 * Fibo + RSI confluence signal.
 * RSI 5m = entry confirmation, RSI 1m = micro timing (highly sensitive, tighter thresholds).
 * 1m RSI has high noise, so oversold threshold is lowered to ≤ 25 (instead of 35).
 */
function rsiDipConfluence(rsi5m, rsi1m, dipSig) {
  if (rsi5m === null) return { confluence: 'insufficient_data', label: 'RSI unavailable' };
  const inGoldenZone = ['strong_dip', 'deep_dip', 'moderate_dip'].includes(dipSig);
  const oversold5m   = rsi5m <= 35;
  const oversold1m   = rsi1m !== null && rsi1m <= 25;   // 1m is noisier, tighter threshold
  const overbought5m = rsi5m >= 75;

  if (inGoldenZone && oversold5m && oversold1m) {
    return { confluence: 'max_conviction',  label: 'Fibo dip + RSI oversold 5m and 1m - pinpoint entry, narrow window' };
  }
  if (inGoldenZone && oversold5m) {
    return { confluence: 'high_conviction', label: 'Fibo dip + RSI 5m oversold - valid entry, 1m unconfirmed' };
  }
  if (inGoldenZone && !oversold5m && oversold1m) {
    return { confluence: 'micro_dip',       label: 'Fibo dip + RSI 1m oversold - capitulation spike, aggressive entry' };
  }
  if (inGoldenZone && !oversold5m && !overbought5m) {
    return { confluence: 'moderate',        label: 'Fibo dip valid but RSI not oversold - wait or scale in' };
  }
  if (inGoldenZone && overbought5m) {
    return { confluence: 'late_entry',      label: 'Fibo dip but RSI overbought - bounce occurred, avoid chasing' };
  }
  if (!inGoldenZone && oversold5m) {
    return { confluence: 'rsi_only',        label: 'RSI oversold but not in fib zone - possible dead cat bounce' };
  }
  return { confluence: 'no_confluence',     label: 'No strong confluence signal' };
}

// ─── ENTRY POINT ──────────────────────────────────────────────────────────────

export function computeFibonacci(candles5m, currentPrice, athPrice, candles1m = null) {
  if (!candles5m || candles5m.length < 10) return { available: false, reason: 'insufficient 5m candles (min 10)' };
  if (!currentPrice || currentPrice <= 0)  return { available: false, reason: 'invalid current price' };

  const candleHigh = Math.max(...candles5m.map(c => c.high));
  const swingHigh  = (athPrice && athPrice > candleHigh) ? athPrice : candleHigh;
  const swingLow   = Math.min(...candles5m.map(c => c.low));

  if (swingHigh <= swingLow) return { available: false, reason: 'swing high <= swing low, invalid range' };

  const levels = calcFibLevels(swingHigh, swingLow);
  const zone   = classifyZone(currentPrice, levels);
  const dip    = dipSignal(zone.zone);

  const distanceTo = (label) => {
    const lvl = levels.find(l => l.label === label);
    if (!lvl) return null;
    return parseFloat(((currentPrice - lvl.price) / lvl.price * 100).toFixed(2));
  };

  const rsi5m     = calcRSI(candles5m.map(c => c.close), 14);
  const rsi1m     = candles1m ? calcRSI(candles1m.map(c => c.close), 14) : null;
  const rsiZone5m = classifyRSI(rsi5m);
  const rsiZone1m = classifyRSI(rsi1m);
  const conf      = rsiDipConfluence(rsi5m, rsi1m, dip.signal);

  return {
    available: true,

    // Fibonacci
    swingHigh,
    swingLow,
    swingSource:         athPrice && athPrice > candleHigh ? 'ath_absolute' : 'candle_window',
    candleCount5m:       candles5m.length,
    candleCount1m:       candles1m?.length ?? 0,
    levels:              Object.fromEntries(levels.map(l => [l.label, l.price])),
    currentPrice,
    zone:                zone.zone,
    upperFib:            zone.upperFib,
    lowerFib:            zone.lowerFib,
    positionInZonePct:   zone.positionInZonePct,
    dipSignal:           dip.signal,
    dipLabel:            dip.label,
    distanceToFib618Pct: distanceTo('fib_618'),
    distanceToFib786Pct: distanceTo('fib_786'),
    distanceToFib50Pct:  distanceTo('fib_50'),
    distanceToAthPct:    distanceTo('fib_0'),

    // RSI — 5m entry confirmation, 1m micro timing (capitulation spike detector)
    rsi: {
      rsi5m,
      rsi1m,
      zone5m:  rsiZone5m.zone,
      label5m: rsiZone5m.label,
      zone1m:  rsiZone1m.zone,
      label1m: rsiZone1m.label,
    },

    // Short confluence signal for LLM
    confluence:      conf.confluence,
    confluenceLabel: conf.label,
  };
}