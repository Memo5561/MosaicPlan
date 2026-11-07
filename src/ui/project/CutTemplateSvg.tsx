import { centroid } from '../../core/geometry';
import type { CutInfo } from '../../core/pieces';
import { useI18n } from '../../i18n';

/** Exakte Schnittvorlage: Rohstein (gestrichelt), Steinkontur, Schnittlinien (rot), Kantenmaße. */
export function CutTemplateSvg({ info, color, size = 220 }: { info: CutInfo; color: string; size?: number }) {
  const { n } = useI18n();
  const pad = 22;
  const s = (size - 2 * pad) / Math.max(info.rawW, info.rawH);
  const W = info.rawW * s + 2 * pad;
  const H = info.rawH * s + 2 * pad;
  const P = (x: number, y: number) => `${pad + x * s},${pad + y * s}`;
  const c = centroid(info.polyInRaw);
  const nPts = info.polyInRaw.length;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="cut-svg" role="img">
      <rect x={pad} y={pad} width={info.rawW * s} height={info.rawH * s} fill="none" stroke="#777" strokeDasharray="4 3" />
      <polygon points={info.polyInRaw.map((p) => P(p.x, p.y)).join(' ')} fill={color} stroke="#111" strokeWidth={1.2} />
      {info.cutLines.map(([a, b], i) => (
        <line key={i} x1={pad + a.x * s} y1={pad + a.y * s} x2={pad + b.x * s} y2={pad + b.y * s} stroke="#d0021b" strokeWidth={1.6} strokeDasharray="6 2" />
      ))}
      {info.polyInRaw.map((a, i) => {
        const b = info.polyInRaw[(i + 1) % nPts];
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const dx = mx - c.x;
        const dy = my - c.y;
        const dl = Math.hypot(dx, dy) || 1;
        const off = 11 / s;
        return (
          <text key={i} x={pad + (mx + (dx / dl) * off) * s} y={pad + (my + (dy / dl) * off) * s} fontSize={10} textAnchor="middle" dominantBaseline="middle" fill="#111">
            {n(info.edges[i], 1)}
          </text>
        );
      })}
      <text x={pad} y={pad - 6} fontSize={9} fill="#555">
        {n(info.rawW, 1)} × {n(info.rawH, 1)} mm
      </text>
    </svg>
  );
}
