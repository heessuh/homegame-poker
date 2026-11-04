// Chip stacks drawn with CSS. Denominations scale with the big blind so colors mean the same thing in chips and dollars mode.
const MULT = [0.5, 1, 5, 25, 100, 500, 2500];
const COLORS = ["#ece4d2", "#c9453b", "#2f8f63", "#2b2420", "#7a4cae", "#d9a441", "#3478c4"];

export function chipGroups(amount: number, bb: number): { color: string; n: number }[] {
  const unit = Math.max(1, bb || 1);
  const den = MULT.map((m) => Math.max(1, Math.round(m * unit)));
  let rest = Math.max(0, Math.round(amount));
  const out: { color: string; n: number }[] = [];
  for (let i = den.length - 1; i >= 0 && rest > 0; i--) {
    const n = Math.floor(rest / den[i]);
    if (n > 0) { out.push({ color: COLORS[i], n: Math.min(n, 7) }); rest -= n * den[i]; }
  }
  if (rest > 0 && out.length < 3) out.push({ color: COLORS[0], n: 1 });
  if (out.length === 0 && amount > 0) out.push({ color: COLORS[0], n: 1 });
  return out.slice(0, 3);
}

export function ChipStack({ amount, bb, small = false }: { amount: number; bb: number; small?: boolean }) {
  const groups = chipGroups(amount, bb);
  return (
    <span className={`chipstack ${small ? "sm" : ""}`} aria-hidden="true">
      {groups.map((g, gi) => (
        <span key={gi} className="chipcol">
          {Array.from({ length: g.n }, (_, i) => <i key={i} className="chp" style={{ ["--c" as string]: g.color }} />)}
        </span>
      ))}
    </span>
  );
}
