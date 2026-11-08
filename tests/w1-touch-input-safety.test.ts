import { describe, expect, it } from 'vitest';
import { parseLocaleNum, parseLocaleNumInfo } from '../src/ui/numberParse';
import { createModalHistory, modalDepth, type ModalHandle } from '../src/ui/modalHistory';
import {
  exceedsTapSlop,
  isTapDuration,
  LONG_PRESS_MS,
  MAX_SCALE,
  MIN_TOUCH_TARGET_PX,
  pieceMinSideMm,
  tapDecision,
  TOUCH_ZOOM_TARGET_PX,
} from '../src/ui/project/touchTap';

describe('parseLocaleNum – deutsche Eingabe', () => {
  const de = (s: string) => parseLocaleNum(s, 'de');
  it('Tausenderpunkt und Dezimalkomma', () => {
    expect(de('1.000')).toBe(1000);
    expect(de('1.000,5')).toBe(1000.5);
    expect(de('1.000.000')).toBe(1_000_000);
    expect(de('12.500,25')).toBe(12500.25);
    expect(de('1.250')).toBe(1250);
  });
  it('Leerzeichen als Tausendertrennung (normal, geschützt, schmal)', () => {
    expect(de('1 000')).toBe(1000);
    expect(de('1 000')).toBe(1000);
    expect(de('1 000,5')).toBe(1000.5);
    expect(de('1 000')).toBe(1000);
    expect(de('  12,5  ')).toBe(12.5);
  });
  it('ein einzelnes Trennzeichen ist das Dezimaltrennzeichen', () => {
    expect(de('12,5')).toBe(12.5);
    expect(de('12.5')).toBe(12.5);
    expect(de('0.125')).toBe(0.125);
    expect(de('0,125')).toBe(0.125);
    expect(de(',5')).toBe(0.5);
    expect(de('1,000')).toBe(1);
    expect(de('1.0000')).toBe(1);
    expect(de('100')).toBe(100);
    expect(de('-2,5')).toBe(-2.5);
    expect(de('−2,5')).toBe(-2.5);
  });
  it('Trennzeichen am Ende ist beim Tippen erlaubt', () => {
    expect(de('12,')).toBe(12);
    expect(de('100.')).toBe(100);
    expect(de('1.000,')).toBe(1000);
  });
  it('unklare oder fehlerhafte Eingaben ergeben NaN', () => {
    for (const s of ['1,2,3', '12abc', '', '   ', '-', ',', '1e3', '1.000.5,3', '1.000,5,5', '12 5', '1 00', '0 500', 'abc', '1,5.5', '+5', '1..5'])
      expect(de(s), s).toBeNaN();
  });
  it('meldet entfernte Gruppierung für den Hinweis', () => {
    expect(parseLocaleNumInfo('1.000', 'de')).toEqual({ value: 1000, regrouped: true });
    expect(parseLocaleNumInfo('1 000', 'de')).toEqual({ value: 1000, regrouped: true });
    expect(parseLocaleNumInfo('12,5', 'de')).toEqual({ value: 12.5, regrouped: false });
    expect(parseLocaleNumInfo(' 12 ', 'de')).toEqual({ value: 12, regrouped: false });
    expect(parseLocaleNumInfo('0.125', 'de')).toEqual({ value: 0.125, regrouped: false });
    expect(parseLocaleNumInfo('1,2,3', 'de').regrouped).toBe(false);
  });
});

describe('parseLocaleNum – Englisch und Türkisch', () => {
  it('en: Tausenderkomma, Dezimalpunkt', () => {
    expect(parseLocaleNum('1,000', 'en')).toBe(1000);
    expect(parseLocaleNum('1,000.5', 'en')).toBe(1000.5);
    expect(parseLocaleNum('1.000', 'en')).toBe(1);
    expect(parseLocaleNum('2.5', 'en')).toBe(2.5);
    expect(parseLocaleNum('12,5', 'en')).toBe(12.5);
    expect(parseLocaleNum('1 000', 'en')).toBe(1000);
    expect(parseLocaleNum('1.000,5', 'en')).toBeNaN();
    expect(parseLocaleNum('1,2,3', 'en')).toBeNaN();
  });
  it('tr: wie Deutsch', () => {
    expect(parseLocaleNum('0,5', 'tr')).toBe(0.5);
    expect(parseLocaleNum('1.000', 'tr')).toBe(1000);
    expect(parseLocaleNum('1.000,5', 'tr')).toBe(1000.5);
    expect(parseLocaleNum('12.5', 'tr')).toBe(12.5);
    expect(parseLocaleNum('1,2,3', 'tr')).toBeNaN();
  });
});

describe('Antippen im Viewer', () => {
  it('Maus wählt immer aus, auch bei winzigen Steinen', () => {
    expect(tapDecision('mouse', 5, 1.1)).toEqual({ pick: true });
  });
  it('Finger in der Gesamtansicht (5-mm-Stein ≈ 6 px) zoomt statt auszuwählen', () => {
    const d = tapDecision('touch', 5, 1.13);
    expect(d.pick).toBe(false);
    if (!d.pick) expect(5 * 1.13 * d.zoom).toBeCloseTo(TOUCH_ZOOM_TARGET_PX, 6);
    expect(tapDecision('pen', 5, 1.13).pick).toBe(false);
  });
  it('Finger wählt aus, sobald der Stein groß genug ist', () => {
    expect(tapDecision('touch', 5, MIN_TOUCH_TARGET_PX / 5)).toEqual({ pick: true });
    expect(tapDecision('touch', 5, 10)).toEqual({ pick: true });
    expect(tapDecision('touch', 5, (MIN_TOUCH_TARGET_PX - 0.5) / 5).pick).toBe(false);
  });
  it('Zoom wird auf den größten Maßstab begrenzt; dort wird ausgewählt', () => {
    const d = tapDecision('touch', 0.1, 100);
    expect(d.pick).toBe(false);
    if (!d.pick) expect(100 * d.zoom).toBeCloseTo(MAX_SCALE, 6);
    expect(tapDecision('touch', 0.1, MAX_SCALE)).toEqual({ pick: true });
  });
  it('Toleranz und lange Drücke', () => {
    expect(exceedsTapSlop('mouse', 4, 3)).toBe(false);
    expect(exceedsTapSlop('mouse', 6, 0)).toBe(true);
    expect(exceedsTapSlop('touch', 6, 3)).toBe(false);
    expect(exceedsTapSlop('touch', 8, 7)).toBe(true);
    expect(isTapDuration('touch', LONG_PRESS_MS)).toBe(true);
    expect(isTapDuration('touch', 1200)).toBe(false);
    expect(isTapDuration('pen', 900)).toBe(false);
    expect(isTapDuration('mouse', 1200)).toBe(true);
  });
  it('Steingröße aus dem Polygon (kleinere Seite des Rechtecks)', () => {
    expect(pieceMinSideMm([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 8 }, { x: 0, y: 8 }])).toBe(5);
    expect(pieceMinSideMm([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 0, y: 5 }])).toBe(5);
    expect(pieceMinSideMm([])).toBe(0);
  });
});

/** Nachbildung von window.history: go() wirkt asynchron und löst danach popstate aus, wie im Browser. */
class FakeHistory {
  entries: { state: unknown }[] = [{ state: null }];
  index = 0;
  goCalls: number[] = [];
  private listeners: (() => void)[] = [];
  constructor(initialState: unknown = null) {
    this.entries[0].state = initialState;
  }
  get state() {
    return this.entries[this.index].state;
  }
  pushState(s: unknown) {
    this.entries.splice(this.index + 1);
    this.entries.push({ state: JSON.parse(JSON.stringify(s)) });
    this.index++;
  }
  go(delta: number) {
    this.goCalls.push(delta);
    setTimeout(() => this.traverse(delta), 1);
  }
  /** Zurück-/Vorwärts-Taste des Benutzers */
  user(delta: number) {
    this.traverse(delta);
  }
  private traverse(delta: number) {
    const ni = Math.max(0, Math.min(this.entries.length - 1, this.index + delta));
    if (ni === this.index) return;
    this.index = ni;
    for (const l of this.listeners) l();
  }
  on(fn: () => void) {
    this.listeners.push(fn);
  }
}

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

function setup(initialState: unknown = null) {
  const h = new FakeHistory(initialState);
  const mh = createModalHistory({
    history: h,
    onPopState: (fn) => h.on(fn),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    queueMicrotask: (fn) => queueMicrotask(fn),
  });
  const closed: string[] = [];
  /** Dialog öffnen; onClose entfernt ihn wie React beim nächsten Rendern */
  const open = (name: string) => {
    const ref: { h?: ModalHandle } = {};
    ref.h = mh.register(() => {
      closed.push(name);
      queueMicrotask(() => ref.h!.release());
    });
    return ref.h;
  };
  return { h, mh, closed, open };
}

describe('Dialoge im Browserverlauf (Zurück-Taste)', () => {
  it('Öffnen legt einen Eintrag an, Zurück schließt den Dialog, die Seite bleibt', async () => {
    const { h, mh, closed, open } = setup();
    open('stone');
    expect(h.entries.length).toBe(2);
    expect(modalDepth(h.state)).toBe(1);
    h.user(-1);
    await tick();
    expect(closed).toEqual(['stone']);
    expect(h.index).toBe(0);
    expect(mh.openCount()).toBe(0);
    expect(h.goCalls).toEqual([]);
  });

  it('✕/Esc gehen über den Verlauf zurück und schließen beim popstate', async () => {
    const { h, closed, open } = setup();
    const a = open('stone');
    a.requestClose();
    expect(closed).toEqual([]); // erst beim popstate
    await tick();
    expect(closed).toEqual(['stone']);
    expect(h.index).toBe(0);
    expect(h.goCalls).toEqual([-1]);
    a.requestClose(); // Doppelklick nach dem Schließen: nichts mehr
    await tick();
    expect(closed).toEqual(['stone']);
  });

  it('programmatisches Schließen (Speichern) entfernt den eigenen Eintrag', async () => {
    const { h, open } = setup();
    const a = open('material');
    a.release();
    await tick();
    expect(h.index).toBe(0);
    expect(h.goCalls).toEqual([-1]);
  });

  it('verschachtelte Dialoge schließen von oben nach unten', async () => {
    const { h, closed, open } = setup();
    const a = open('stone');
    const b = open('free');
    expect(modalDepth(h.state)).toBe(2);
    expect(a.isTop()).toBe(false);
    expect(b.isTop()).toBe(true);
    h.user(-1);
    await tick();
    expect(closed).toEqual(['free']);
    expect(a.isTop()).toBe(true);
    h.user(-1);
    await tick();
    expect(closed).toEqual(['free', 'stone']);
    expect(h.index).toBe(0);
  });

  it('StrictMode-Doppel-Mount legt keinen zweiten Eintrag an', async () => {
    const { h, closed, open } = setup();
    const first = open('stone');
    first.release(); // StrictMode: Aufräumen …
    const second = open('stone'); // … und sofort neu einhängen
    await tick();
    expect(h.entries.length).toBe(2);
    expect(h.index).toBe(1);
    expect(h.goCalls).toEqual([]);
    second.requestClose();
    await tick();
    expect(closed).toEqual(['stone']);
    expect(h.index).toBe(0);
  });

  it('gleichzeitiges Entfernen beider Dialoge geht genau bis zum Basiseintrag zurück', async () => {
    const { h, open } = setup();
    const a = open('stone');
    const b = open('free');
    a.release();
    b.release();
    await tick();
    expect(h.goCalls).toEqual([-2]);
    expect(h.index).toBe(0);
  });

  it('Schließen eines unteren Dialogs lässt den oberen offen und gleicht die Tiefe an', async () => {
    const { h, closed, open } = setup();
    const a = open('A');
    open('B');
    a.requestClose();
    await tick();
    expect(closed).toEqual(['A']);
    expect(modalDepth(h.state)).toBe(1);
    h.user(-1);
    await tick();
    expect(closed).toEqual(['A', 'B']);
    expect(h.index).toBe(0);
  });

  it('Vorwärts auf einen veralteten Dialog-Eintrag springt sofort zurück, ohne etwas zu schließen', async () => {
    const { h, closed, open } = setup();
    const a = open('stone');
    a.requestClose();
    await tick();
    h.user(+1);
    await tick();
    expect(h.index).toBe(0);
    expect(closed).toEqual(['stone']);
  });

  it('nach Neuladen auf einem Dialog-Eintrag geht es zum Basiseintrag zurück', async () => {
    const h = new FakeHistory(null);
    h.pushState({ mpModal: 1, mpModalDepth: 1 });
    createModalHistory({
      history: h,
      onPopState: (fn) => h.on(fn),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
      queueMicrotask: (fn) => queueMicrotask(fn),
    });
    await tick();
    expect(h.index).toBe(0);
  });

  it('fremder Verlaufszustand bleibt erhalten', async () => {
    const { h, open } = setup({ step: 'preview' });
    const a = open('stone');
    expect(h.state).toMatchObject({ step: 'preview', mpModalDepth: 1 });
    a.requestClose();
    await tick();
    expect(h.state).toEqual({ step: 'preview' });
  });

  it('Zurück über mehrere Einträge schließt alle offenen Dialoge', async () => {
    const { h, closed, open } = setup();
    open('A');
    open('B');
    h.user(-2);
    await tick();
    expect(closed).toEqual(['B', 'A']);
    expect(h.index).toBe(0);
  });
});
