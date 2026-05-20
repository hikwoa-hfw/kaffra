
const FIB_LEVELS = [
  { label: 'fib_0',    ratio: 0 },     
  { label: 'fib_236',  ratio: 0.236 },
  { label: 'fib_382',  ratio: 0.382 },
  { label: 'fib_50',   ratio: 0.5 },
  { label: 'fib_618',  ratio: 0.618 },   // Golden ratio — zona rebound paling kuat
  { label: 'fib_786',  ratio: 0.786 },   // Deep retracement — sering jadi dip bottom
  { label: 'fib_100',  ratio: 1 },       // Swing low
];

function calcFibLevels(high, low) {
  const range = high - low;
  return FIB_LEVELS.map(({ label, ratio }) => ({
    label,
    ratio,
    price: parseFloat((high - ratio * range).toFixed(12)),
  }));
}

function classifyZone(currentPrice, levels) {
  // levels sudah sorted dari high (fib_0) ke low (fib_100)
  for (let i = 0; i < levels.length - 1; i++) {
    const upper = levels[i];
    const lower = levels[i + 1];
    if (currentPrice <= upper.price && currentPrice >= lower.price) {
      const zoneRange = upper.price - lower.price;
      const positionInZonePct = zoneRange > 0
        ? parseFloat(((upper.price - currentPrice) / zoneRange * 100).toFixed(2))
        : 0;
      return {
        zone:               `${upper.label}–${lower.label}`,
        upperFib:           upper.label,
        lowerFib:           lower.label,
        positionInZonePct,  // 0% = tepat di upper, 100% = tepat di lower
      };
    }
  }

  // Di luar range (di atas ATH atau di bawah swing low)
  if (currentPrice > levels[0].price)  return { zone: 'above_ath',       upperFib: null, lowerFib: 'fib_0',   positionInZonePct: null };
  if (currentPrice < levels.at(-1).price) return { zone: 'below_swing_low', upperFib: 'fib_100', lowerFib: null, positionInZonePct: null };
  return { zone: 'unknown', upperFib: null, lowerFib: null, positionInZonePct: null };
}

function dipSignal(zone) {
  const signals = {
    'fib_618–fib_786': { signal: 'strong_dip',   label: 'Zona golden dip — entry ideal untuk bounce' },
    'fib_786–fib_100': { signal: 'deep_dip',      label: 'Deep retracement — high risk, high reward' },
    'fib_50–fib_618':  { signal: 'moderate_dip',  label: 'Pullback sehat — bisa entry dengan konfirmasi BSR' },
    'fib_382–fib_50':  { signal: 'shallow_dip',   label: 'Koreksi dangkal — belum banyak tekanan jual' },
    'fib_236–fib_382': { signal: 'minor_pullback', label: 'Minor pullback — harga masih kuat' },
    'fib_0–fib_236':   { signal: 'near_ath',       label: 'Dekat ATH — bukan zona dip, hindari chase' },
    'above_ath':       { signal: 'breakout',       label: 'Price discovery — di atas ATH sebelumnya' },
    'below_swing_low': { signal: 'danger',         label: 'Di bawah swing low — kemungkinan dump lanjut' },
  };
  return signals[zone] ?? { signal: 'unknown', label: 'Zona tidak terdefinisi' };
}

/**
 * Entry point utama — dipanggil dari candidateBuilder.
 *
 * @param {Array}  candles      - dari fetchOHLC(), sorted ascending
 * @param {number} currentPrice - harga sekarang (gmgn.price.price atau metrics.priceUsd)
 * @param {number} athPrice     - dari gmgn.ath_price (ceiling absolut)
 * @returns {Object} fibonacci result untuk dimasukkan ke candidate.chart.fibonacci
 */
export function computeFibonacci(candles, currentPrice, athPrice) {
  if (!candles || candles.length < 10) {
    return { available: false, reason: 'candle data tidak cukup (min 10)' };
  }
  if (!currentPrice || currentPrice <= 0) {
    return { available: false, reason: 'harga sekarang tidak valid' };
  }

  const candleHigh  = Math.max(...candles.map(c => c.high));
  const swingHigh   = (athPrice && athPrice > candleHigh) ? athPrice : candleHigh;

  const swingLow    = Math.min(...candles.map(c => c.low));

  if (swingHigh <= swingLow) {
    return { available: false, reason: 'swing high <= swing low, range tidak valid' };
  }

  const levels       = calcFibLevels(swingHigh, swingLow);
  const zone         = classifyZone(currentPrice, levels);
  const dip          = dipSignal(zone.zone);

  const distanceTo = (label) => {
    const lvl = levels.find(l => l.label === label);
    if (!lvl) return null;
    return parseFloat(((currentPrice - lvl.price) / lvl.price * 100).toFixed(2));
  };

  return {
    available:         true,
    swingHigh,
    swingLow,
    swingSource:       athPrice && athPrice > candleHigh ? 'ath_absolute' : 'candle_window',
    candleCount:       candles.length,
    levels:            Object.fromEntries(levels.map(l => [l.label, l.price])),

    currentPrice,
    zone:              zone.zone,
    upperFib:          zone.upperFib,
    lowerFib:          zone.lowerFib,
    positionInZonePct: zone.positionInZonePct,

    dipSignal:         dip.signal,
    dipLabel:          dip.label,

    distanceToFib618Pct: distanceTo('fib_618'),
    distanceToFib786Pct: distanceTo('fib_786'),
    distanceToFib50Pct:  distanceTo('fib_50'),
    distanceToAthPct:    distanceTo('fib_0'),
  };
}