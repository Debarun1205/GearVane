// Raise --border-strong to clear 3:1 on all three backgrounds, keeping the
// blue-slate hue rather than drifting to grey.
import { contrast, PALETTE } from '../src/contrast.ts';

function ok(hex) {
  return (
    contrast(hex, PALETTE.bg).ratio >= 3 &&
    contrast(hex, PALETTE.bgRaised).ratio >= 3 &&
    contrast(hex, PALETTE.bgSoft).ratio >= 3
  );
}

function hex(n) {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
}

// The current hue: #33415e is r=51 g=65 b=94. Hold the ratio and scale up.
const r0 = 0x33, g0 = 0x41, b0 = 0x5e;
console.log('scaling the current blue-slate hue:');
for (let k = 1.3; k <= 2.4; k += 0.1) {
  const candidate = `#${hex(r0 * k)}${hex(g0 * k)}${hex(b0 * k)}`;
  console.log(
    `  k=${k.toFixed(1)}  ${candidate}  bg ${contrast(candidate, PALETTE.bg).ratio.toFixed(2)}` +
      `  raised ${contrast(candidate, PALETTE.bgRaised).ratio.toFixed(2)}` +
      `  soft ${contrast(candidate, PALETTE.bgSoft).ratio.toFixed(2)}` +
      `  ${ok(candidate) ? 'PASSES' : ''}`,
  );
}

console.log('\nand --border, the decorative one, on the same hue:');
for (const k of [1.7, 1.8, 1.9, 2.0]) {
  const candidate = `#${hex(r0 * k)}${hex(g0 * k)}${hex(b0 * k)}`;
  console.log(
    `  k=${k.toFixed(1)}  ${candidate}  bg ${contrast(candidate, PALETTE.bg).ratio.toFixed(2)}` +
      `  ${ok(candidate) ? 'PASSES 3:1' : 'decorative only'}`,
  );
}