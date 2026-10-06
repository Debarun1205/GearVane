// Find a border colour that clears the 3:1 non-text minimum on both backgrounds.
import { PALETTE, contrast } from '../src/contrast.ts';

function lum(hex) {
  const ch = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const c = hex.replace('#', '');
  return (
    0.2126 * ch(parseInt(c.slice(0, 2), 16)) +
    0.7152 * ch(parseInt(c.slice(2, 4), 16)) +
    0.0722 * ch(parseInt(c.slice(4, 6), 16))
  );
}

// Walk lightness up in small steps, holding hue roughly constant, and report
// the first value that clears 3:1 on the darkest background.
function hex(n) {
  return n.toString(16).padStart(2, '0');
}

console.log('current borderStrong:', PALETTE.borderStrong);
console.log('  on bg       ', contrast(PALETTE.borderStrong, PALETTE.bg).ratio.toFixed(2));
console.log('  on bgRaised ', contrast(PALETTE.borderStrong, PALETTE.bgRaised).ratio.toFixed(2));
console.log('  on bgSoft   ', contrast(PALETTE.borderStrong, PALETTE.bgSoft).ratio.toFixed(2));

console.log('\ncandidates (same hue family, increasing lightness):');
for (const r of [0x3f, 0x4a, 0x55, 0x60, 0x6b]) {
  const candidate = `#${hex(r)}${hex(r + 6)}${hex(r + 16)}`;
  const onBg = contrast(candidate, PALETTE.bg).ratio;
  const onRaised = contrast(candidate, PALETTE.bgRaised).ratio;
  const onSoft = contrast(candidate, PALETTE.bgSoft).ratio;
  console.log(
    `  ${candidate}  bg ${onBg.toFixed(2)}  raised ${onRaised.toFixed(2)}  soft ${onSoft.toFixed(2)}  ` +
      `border=${onBg >= 3 && onRaised >= 3 && onSoft >= 3 ? 'PASSES 3:1' : 'fails'}`,
  );
}

// The dim border is decorative; only the strong one identifies controls. But
// check both so the choice is informed.
console.log('\ncurrent --border (decorative):');
for (const bg of ['bg', 'bgRaised', 'bgSoft']) {
  console.log(`  on ${bg}: ${contrast(PALETTE.border, PALETTE[bg]).ratio.toFixed(2)}`);
}