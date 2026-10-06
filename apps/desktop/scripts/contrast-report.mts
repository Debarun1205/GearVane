// Print the contrast audit so the numbers can be read, not guessed.
import { PAIRS, PALETTE, contrast } from '../src/contrast.ts';

const rows = PAIRS.map(({ what, fg, bg }) => {
  const c = contrast(PALETTE[fg], PALETTE[bg]);
  return { what, fg, bg, ratio: c.ratio, aa: c.aa, aaLarge: c.aaLarge, aaa: c.aaa };
});

rows.sort((a, b) => a.ratio - b.ratio);

function mark(ok) {
  return ok ? ' ok ' : 'FAIL';
}

console.log('ratio  AA   AAL  AAA  pair');
for (const r of rows) {
  console.log(
    `${r.ratio.toFixed(2).padStart(5)}  ${mark(r.aa)} ${mark(r.aaLarge)} ${mark(r.aaa)}  ` +
      `${r.fg} on ${r.bg}  (${r.what})`,
  );
}

const failing = rows.filter((r) => !r.aa);
console.log(`\n${failing.length} of ${rows.length} pairs fail AA for normal text:`);
for (const r of failing) console.log(`  ${r.ratio.toFixed(2)}  ${r.what} (${r.fg} on ${r.bg})`);

const nonText = rows.filter((r) => !r.aaLarge);
console.log(`\n${nonText.length} pairs fail even the 3:1 non-text minimum:`);
for (const r of nonText) console.log(`  ${r.ratio.toFixed(2)}  ${r.what}`);