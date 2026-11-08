import { minInteriorAngle, pointInPolygon } from '../../core/geometry';
import type { CutInfo } from '../../core/pieces';
import { useI18n } from '../../i18n';
import { Badge } from '../components';
import '../css/w1-cut-correctness.css';

/** Unter diesem Innenwinkel gilt ein Teil als schwierig zu schneiden (reiner Hinweis, Richtwert). */
export const DIFFICULT_ANGLE_DEG = 25;

/**
 * Exakte Schnittvorlage: Rohstein (gestrichelt), Steinkontur, durchgehende Schnitte (rot gestrichelt),
 * Einschnitte bis zur Innenecke (orange gepunktet), Kantenmaße.
 */
export function CutTemplateSvg({ info, color, size = 220 }: { info: CutInfo; color: string; size?: number }) {
  const { t, n } = useI18n();
  const pad = 22;
  const s = (size - 2 * pad) / Math.max(info.rawW, info.rawH);
  const W = info.rawW * s + 2 * pad;
  const H = info.rawH * s + 2 * pad;
  const P = (x: number, y: number) => `${pad + x * s},${pad + y * s}`;
  if (info.invalid || info.polyInRaw.length < 3) {
    return (
      <div className="cut-template" data-testid="cut-template">
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="cut-svg" role="img" aria-label={t('stone.invalid')}>
          <rect x={pad} y={pad} width={info.rawW * s} height={info.rawH * s} fill="none" stroke="#777" strokeDasharray="4 3" />
          <text x={W / 2} y={H / 2} fontSize={12} textAnchor="middle" dominantBaseline="middle" fill="#b3261e">
            {t('stone.invalid')}
          </text>
        </svg>
      </div>
    );
  }
  const nPts = info.polyInRaw.length;
  const minAngle = minInteriorAngle(info.polyInRaw);
  const kindOf = (i: number) => info.cutKinds[i] ?? 'through';
  return (
    <div className="cut-template" data-testid="cut-template">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="cut-svg" role="img">
        <rect x={pad} y={pad} width={info.rawW * s} height={info.rawH * s} fill="none" stroke="#777" strokeDasharray="4 3" />
        <polygon points={info.polyInRaw.map((p) => P(p.x, p.y)).join(' ')} fill={color} stroke="#111" strokeWidth={1.2} />
        {info.cutLines.map(([a, b], i) =>
          kindOf(i) === 'notch' ? (
            <g key={i} data-cut-kind="notch">
              <line x1={pad + a.x * s} y1={pad + a.y * s} x2={pad + b.x * s} y2={pad + b.y * s} stroke="#ef6c00" strokeWidth={3.4} strokeDasharray="0.1 5.4" strokeLinecap="round" />
              <circle cx={pad + b.x * s} cy={pad + b.y * s} r={3.6} fill="#fff" stroke="#ef6c00" strokeWidth={1.8} />
            </g>
          ) : (
            <line key={i} data-cut-kind="through" x1={pad + a.x * s} y1={pad + a.y * s} x2={pad + b.x * s} y2={pad + b.y * s} stroke="#d0021b" strokeWidth={1.6} strokeDasharray="6 2" />
          ),
        )}
        {info.polyInRaw.map((a, i) => {
          const b = info.polyInRaw[(i + 1) % nPts];
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          // Maß außen neben die Kante setzen (senkrecht zur Kante, auf der Seite außerhalb des Steins)
          const ex = b.x - a.x;
          const ey = b.y - a.y;
          const el = Math.hypot(ex, ey) || 1;
          let nx = ey / el;
          let ny = -ex / el;
          const probe = 0.5 / s;
          if (pointInPolygon({ x: mx + nx * probe, y: my + ny * probe }, info.polyInRaw)) {
            nx = -nx;
            ny = -ny;
          }
          const off = 10 / s;
          return (
            <text key={i} x={pad + (mx + nx * off) * s} y={pad + (my + ny * off) * s} fontSize={10} textAnchor="middle" dominantBaseline="middle" fill="#111">
              {n(info.edges[i], 1)}
            </text>
          );
        })}
      </svg>
      <small className="muted cut-raw-caption">
        {t('stone.raw')} {n(info.rawW, 1)} × {n(info.rawH, 1)} mm
      </small>
      {info.needsCut && minAngle > 0 && minAngle < DIFFICULT_ANGLE_DEG && (
        <div className="cut-difficult" data-testid="cut-difficult">
          <Badge kind="warn">{t('cut.difficult', { a: n(minAngle, 1) })}</Badge>
        </div>
      )}
    </div>
  );
}
