import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------- simuliertes Dateisystem + Teilen
const h = vi.hoisted(() => {
  type Key = string;
  const files = new Map<Key, Uint8Array>();
  const dirs = new Set<Key>();
  const key = (dir: string | undefined, path: string) => `${dir ?? ''}:${path}`;
  const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
  const fail: {
    writeFile?: (o: { directory?: string; path: string }) => unknown;
    copy?: (o: { to: string }) => unknown;
    stat?: (o: { directory?: string; path: string }) => unknown;
    statSize?: (real: number, o: { directory?: string; path: string }) => number;
  } = {};
  const calls: string[] = [];
  const decode = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'));
  const err = (message: string, code?: string) => Object.assign(new Error(message), code ? { code } : {});
  const Filesystem = {
    writeFile: vi.fn(async (o: { path: string; data: string; directory?: string; recursive?: boolean }) => {
      calls.push(`writeFile ${o.directory}:${o.path}`);
      const f = fail.writeFile?.(o);
      if (f) throw f;
      files.set(key(o.directory, o.path), decode(o.data));
      return { uri: `file:///data/${o.directory}/${o.path}` };
    }),
    appendFile: vi.fn(async (o: { path: string; data: string; directory?: string }) => {
      calls.push(`appendFile ${o.directory}:${o.path}`);
      const k = key(o.directory, o.path);
      const prev = files.get(k) ?? new Uint8Array(0);
      const add = decode(o.data);
      const out = new Uint8Array(prev.length + add.length);
      out.set(prev);
      out.set(add, prev.length);
      files.set(k, out);
    }),
    stat: vi.fn(async (o: { path: string; directory?: string }) => {
      calls.push(`stat ${o.directory}:${o.path}`);
      const f = fail.stat?.(o);
      if (f) throw f;
      const d = files.get(key(o.directory, o.path));
      if (!d) throw err('does not exist', 'OS-PLUG-FILE-0008');
      const size = fail.statSize ? fail.statSize(d.length, o) : d.length;
      return { size, uri: `file:///data/${o.directory}/${o.path}`, type: 'file', name: o.path, mtime: 0 };
    }),
    copy: vi.fn(async (o: { from: string; to: string; directory?: string; toDirectory?: string }) => {
      calls.push(`copy ${o.directory}:${o.from} -> ${o.toDirectory}:${o.to}`);
      const f = fail.copy?.(o);
      if (f) throw f;
      const src = files.get(key(o.directory, o.from));
      if (!src) throw err('does not exist', 'OS-PLUG-FILE-0008');
      const parent = parentOf(o.to);
      if (parent && !dirs.has(key(o.toDirectory, parent))) throw err('Missing parent directory', 'OS-PLUG-FILE-0011');
      files.set(key(o.toDirectory, o.to), src.slice());
      return { uri: `file:///storage/${o.toDirectory}/${o.to}` };
    }),
    mkdir: vi.fn(async (o: { path: string; directory?: string }) => {
      calls.push(`mkdir ${o.directory}:${o.path}`);
      const k = key(o.directory, o.path);
      if (dirs.has(k)) throw err('Directory already exists', 'OS-PLUG-FILE-0010');
      dirs.add(k);
    }),
  };
  const share = vi.fn(async (_o: { files?: string[]; title?: string }) => ({ activityType: 'com.google.android.apps.docs' }));
  const native = { value: true };
  return { files, dirs, key, fail, calls, Filesystem, share, native, err };
});

vi.mock('@capacitor/filesystem', () => ({ Directory: { Documents: 'DOCUMENTS', Cache: 'CACHE' }, Filesystem: h.Filesystem }));
vi.mock('@capacitor/share', () => ({ Share: { share: h.share } }));
vi.mock('@capacitor/core', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@capacitor/core')>();
  return { ...orig, Capacitor: { ...orig.Capacitor, isNativePlatform: () => h.native.value } };
});

import {
  backAction,
  base64Chunks,
  bytesToBase64,
  CHUNK_BYTES,
  chunkRanges,
  isRootHash,
  reshare,
  saveNative,
  splitFileName,
  systemBarStyles,
  timestampedName,
  withSuffix,
  type NativeSaveResult,
} from '../src/platform';
import { SystemBarsStyle } from '@capacitor/core';
import { downloadBlob } from '../src/ui/components';
import { _hostEntries, SaveResultNote, saveNoteState } from '../src/ui/SaveResultNote';

function bytes(n: number, seed = 7): Uint8Array {
  const b = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    b[i] = x >>> 24;
  }
  return b;
}
const blobOf = (b: Uint8Array, type = 'application/pdf') => new Blob([b as BlobPart], { type });
const docs = (name: string) => h.files.get(h.key('DOCUMENTS', `MosaicPlan/${name}`));
const fixedNow = () => new Date(2026, 10, 8, 14, 32, 5);

beforeEach(() => {
  h.files.clear();
  h.dirs.clear();
  h.calls.length = 0;
  for (const k of Object.keys(h.fail)) delete (h.fail as Record<string, unknown>)[k];
  h.share.mockReset();
  h.share.mockImplementation(async () => ({ activityType: 'x' }));
  h.native.value = true;
  vi.clearAllMocks();
});

describe('Base64 in Stücken', () => {
  it('3 MiB sind ein Vielfaches von 3; Bereiche decken die Datei lückenlos ab', () => {
    expect(CHUNK_BYTES).toBe(3 * 1024 * 1024);
    expect(CHUNK_BYTES % 3).toBe(0);
    const r = chunkRanges(7 * 1024 * 1024 + 5);
    expect(r.length).toBe(3);
    expect(r[0]).toEqual([0, CHUNK_BYTES]);
    expect(r[2][1]).toBe(7 * 1024 * 1024 + 5);
    for (let i = 1; i < r.length; i++) expect(r[i][0]).toBe(r[i - 1][1]);
    expect(chunkRanges(0)).toEqual([[0, 0]]);
    expect(() => chunkRanges(10, 4)).toThrow();
  });

  it('jedes Stück ist für sich gültiges Base64 und alle zusammen ergeben exakt die Originalbytes', async () => {
    for (const [size, chunk] of [
      [7 * 1024 * 1024 + 2, CHUNK_BYTES],
      [10_001, 3 * 1000],
      [2, 3],
      [0, CHUNK_BYTES],
    ] as const) {
      const orig = bytes(size, size + 1);
      const pieces: string[] = [];
      for await (const p of base64Chunks(blobOf(orig), chunk)) pieces.push(p);
      expect(pieces.length).toBe(Math.max(1, Math.ceil(size / chunk)));
      // nur das letzte Stück darf Füllzeichen haben
      for (const p of pieces.slice(0, -1)) expect(p.includes('=')).toBe(false);
      const decoded = Buffer.concat(pieces.map((p) => Buffer.from(p, 'base64')));
      expect(decoded.length).toBe(size);
      expect(Buffer.compare(decoded, Buffer.from(orig))).toBe(0);
    }
  });

  it('bytesToBase64 entspricht Buffer.toString("base64")', () => {
    const b = bytes(100_003);
    expect(bytesToBase64(b)).toBe(Buffer.from(b).toString('base64'));
  });
});

describe('Dateinamen', () => {
  it('timestampedName hängt Datum und Uhrzeit an, Endung bleibt', () => {
    const d = new Date(2026, 10, 8, 9, 5);
    expect(timestampedName('Katze', 'mosaicplan.json', d)).toBe('Katze_2026-11-08_0905.mosaicplan.json');
    expect(timestampedName('Plan', '.pdf', d)).toBe('Plan_2026-11-08_0905.pdf');
    expect(timestampedName('x', '', d)).toBe('x_2026-11-08_0905');
  });
  it('splitFileName/withSuffix behandeln .mosaicplan.json als eine Endung', () => {
    expect(splitFileName('a.b.mosaicplan.json')).toEqual({ base: 'a.b', ext: '.mosaicplan.json' });
    expect(splitFileName('plan.pdf')).toEqual({ base: 'plan', ext: '.pdf' });
    expect(splitFileName('ohne')).toEqual({ base: 'ohne', ext: '' });
    expect(withSuffix('Katze_verlegeplan.pdf', '_143205')).toBe('Katze_verlegeplan_143205.pdf');
    expect(withSuffix('K.mosaicplan.json', '_2')).toBe('K_2.mosaicplan.json');
  });
});

describe('saveNative (APK) mit simuliertem Dateisystem', () => {
  it('Erfolg: stückweise in den Cache, nativ nach Documents/MosaicPlan kopiert, Größe geprüft; kein Teilen-Menü', async () => {
    const orig = bytes(7 * 1024 * 1024 + 11);
    const r = await saveNative(blobOf(orig), 'Katze_verlegeplan.pdf', { now: fixedNow });
    expect(r.savedPath).toBe('Documents/MosaicPlan/Katze_verlegeplan.pdf');
    expect(r.savedName).toBe('Katze_verlegeplan.pdf');
    expect(r.cacheUri).toBe('file:///data/CACHE/MosaicPlan/Katze_verlegeplan.pdf');
    expect(r.error).toBeUndefined();
    expect(r.shared).toBe(false);
    expect(h.share).not.toHaveBeenCalled();
    expect(h.Filesystem.writeFile).toHaveBeenCalledTimes(1);
    expect(h.Filesystem.appendFile).toHaveBeenCalledTimes(2);
    // Base64 geht nur einmal über die Brücke; Documents entsteht per copy
    expect(h.Filesystem.writeFile.mock.calls.every(([o]) => o.directory === 'CACHE')).toBe(true);
    expect(Buffer.compare(Buffer.from(docs('Katze_verlegeplan.pdf')!), Buffer.from(orig))).toBe(0);
    // fehlender Ordner wurde einmal angelegt
    expect(h.calls.filter((c) => c.startsWith('mkdir')).length).toBe(1);
  });

  it('abgelehntes Schreiben in Documents (Berechtigung): savedPath null, Grund, Teilen-Menü als Ausweg; Abbrechen ist kein Fehler', async () => {
    h.fail.copy = () => h.err('Unable to do file operation, user denied permission request.', 'OS-PLUG-FILE-0007');
    h.share.mockImplementation(async () => {
      throw new Error('Share canceled');
    });
    const r = await saveNative(blobOf(bytes(5000)), 'plan.pdf', { now: fixedNow });
    expect(r.savedPath).toBeNull();
    expect(r.savedName).toBeNull();
    expect(r.reason).toBe('permission');
    expect(r.error).toMatch(/denied permission/);
    expect(r.cacheUri).toBe('file:///data/CACHE/MosaicPlan/plan.pdf');
    expect(h.share).toHaveBeenCalledTimes(1);
    expect(h.share.mock.calls[0][0].files).toEqual([r.cacheUri]);
    expect(r.shared).toBe(false);
    expect(r.shareError).toBeUndefined();
    // bei verweigerter Berechtigung kein zweiter Versuch unter anderem Namen
    expect(h.calls.filter((c) => c.startsWith('copy')).length).toBe(1);
    expect(docs('plan.pdf')).toBeUndefined();
  });

  it('Konflikt mit gleichnamiger fremder Datei (EACCES nach Neuinstallation): einmal mit Uhrzeit-Zusatz, gemeldet wird der echte Name', async () => {
    h.dirs.add(h.key('DOCUMENTS', 'MosaicPlan'));
    h.fail.copy = (o) => (o.to === 'MosaicPlan/plan.pdf' ? h.err("'copy' failed with: /storage/emulated/0/Documents/MosaicPlan/plan.pdf: open failed: EACCES (Permission denied)", 'OS-PLUG-FILE-0013') : null);
    const r = await saveNative(blobOf(bytes(300)), 'plan.pdf', { now: fixedNow });
    expect(r.savedName).toBe('plan_143205.pdf');
    expect(r.savedPath).toBe('Documents/MosaicPlan/plan_143205.pdf');
    expect(docs('plan_143205.pdf')?.length).toBe(300);
    expect(h.share).not.toHaveBeenCalled();
    // scheitern beide Namen, wird ehrlich „nicht gespeichert“ gemeldet
    h.fail.copy = () => h.err("'copy' failed with: EIO", 'OS-PLUG-FILE-0013');
    const r2 = await saveNative(blobOf(bytes(300)), 'plan2.pdf', { now: fixedNow });
    expect(r2.savedPath).toBeNull();
    expect(r2.reason).toBe('other');
    expect(r2.error).toMatch(/EIO/);
    expect(h.calls.filter((c) => c.includes('plan2') && c.startsWith('copy')).length).toBe(2);
  });

  it('falsche Größe in Documents: nicht als gespeichert melden', async () => {
    h.fail.statSize = (real, o) => (o.directory === 'DOCUMENTS' ? real - 1 : real);
    const r = await saveNative(blobOf(bytes(1000)), 'a.csv', { now: fixedNow });
    expect(r.savedPath).toBeNull();
    expect(r.reason).toBe('size');
    expect(r.error).toBe('999 / 1000 B');
    expect(h.share).toHaveBeenCalledTimes(1);
    expect(r.shared).toBe(true);
  });

  it('schon der Cache scheitert (Speicher voll): Fehler im Ergebnis, kein Teilen, kein Wurf', async () => {
    h.fail.writeFile = () => h.err('No space left on device');
    const r = await saveNative(blobOf(bytes(10)), 'b.pdf');
    expect(r).toMatchObject({ kind: 'native', savedPath: null, cacheUri: null, reason: 'cache', shared: false });
    expect(r.error).toMatch(/No space/);
    expect(h.share).not.toHaveBeenCalled();
  });

  it("share: 'always' öffnet das Teilen-Menü auch nach Erfolg; Teilen-Fehler wird gemeldet", async () => {
    h.share.mockImplementation(async () => {
      throw new Error("Can't share while sharing is in progress");
    });
    const r = await saveNative(blobOf(bytes(10)), 'c.pdf', { share: 'always' });
    expect(r.savedPath).toBe('Documents/MosaicPlan/c.pdf');
    expect(r.shared).toBe(false);
    expect(r.shareError).toMatch(/in progress/);
    const again = await reshare(r.cacheUri!, 'c.pdf');
    expect(again.shared).toBe(false);
    expect(again.error).toMatch(/in progress/);
  });
});

describe('downloadBlob + SaveResultNote', () => {
  it('im APK: abgelehntes Schreiben → savedPath null, app-weite Meldung, Anzeige warnt statt einen Pfad zu nennen', async () => {
    h.fail.copy = () => h.err('Unable to do file operation, user denied permission request.', 'OS-PLUG-FILE-0007');
    h.share.mockImplementation(async () => {
      throw new Error('Share canceled');
    });
    const before = _hostEntries().length;
    const r = (await downloadBlob(blobOf(bytes(64)), 'Katze_verlegeplan.pdf')) as NativeSaveResult;
    expect(r.kind).toBe('native');
    expect(r.savedPath).toBeNull();
    expect(saveNoteState(r)).toBe('not-saved');
    expect(_hostEntries().length).toBe(before + 1);
    expect(_hostEntries().at(-1)?.sticky).toBe(true);

    const html = renderToStaticMarkup(createElement(SaveResultNote, { result: r }));
    expect(html).toContain('data-state="not-saved"');
    expect(html).toContain('Nicht im Ordner „Documents“ gespeichert');
    expect(html).toContain('Der Speicherzugriff wurde nicht erlaubt');
    expect(html).toContain('data-testid="save-note-share"');
    expect(html).not.toContain('Documents/MosaicPlan/');
    expect(html).not.toContain('Gespeichert:');
  });

  it('im APK mit announce:false keine app-weite Meldung; Erfolg zeigt den echten Pfad', async () => {
    const before = _hostEntries().length;
    const r = await downloadBlob(blobOf(bytes(64)), 'x.mosaicplan.json', { announce: false });
    expect(_hostEntries().length).toBe(before);
    expect(r.kind === 'native' && r.savedPath).toBe('Documents/MosaicPlan/x.mosaicplan.json');
    // <wbr> nur als Umbruchhilfe im Pfad
    const html = renderToStaticMarkup(createElement(SaveResultNote, { result: r })).replace(/<wbr\/?>/g, '');
    expect(html).toContain('data-state="saved"');
    expect(html).toContain('Gespeichert:');
    expect(html).toContain('Documents/MosaicPlan/x.mosaicplan.json');
  });

  it('Fehler schon beim Cache: Fehlermeldung ohne Teilen-Knopf', () => {
    const r: NativeSaveResult = { kind: 'native', name: 'a.pdf', savedName: null, savedPath: null, cacheUri: null, shared: false, error: 'No space left', reason: 'cache' };
    const html = renderToStaticMarkup(createElement(SaveResultNote, { result: r }));
    expect(html).toContain('data-state="failed"');
    expect(html).toContain('konnte nicht gespeichert werden');
    expect(html).toContain('No space left');
    expect(html).not.toContain('save-note-share');
  });

  it('Browser: Download-Ergebnis ohne erfundenen Ordner', () => {
    const html = renderToStaticMarkup(createElement(SaveResultNote, { result: { kind: 'download', name: 'k.pdf' } }));
    expect(html).toContain('data-state="download"');
    expect(html).toContain('k.pdf');
    expect(html).not.toContain('Documents');
  });
});

describe('Zurück-Taste und Systemleisten', () => {
  it('backAction: Dialog → zurück, Startseite → minimieren, sonst zurück bzw. zur Startseite', () => {
    expect(backAction(true, '#/project/abc/preview', true)).toBe('back');
    expect(backAction(true, '#/', true)).toBe('back');
    expect(backAction(false, '#/', true)).toBe('minimize');
    expect(backAction(true, '#/', false)).toBe('minimize');
    expect(backAction(true, '', false)).toBe('minimize');
    expect(backAction(true, '#/project/abc/colors', false)).toBe('back');
    expect(backAction(false, '#/project/abc/colors', false)).toBe('home');
    expect(backAction(false, '#/settings', false)).toBe('home');
    expect(isRootHash('#')).toBe(true);
    expect(isRootHash('#/projects')).toBe(false);
  });

  it('Systemleisten: unter der Statusleiste helle Symbole (Dark) und dunkle Navigationssymbole (Light), sonst DEFAULT', () => {
    expect(systemBarStyles(true)).toEqual({ status: SystemBarsStyle.Dark, nav: SystemBarsStyle.Light });
    expect(systemBarStyles(false)).toEqual({ status: SystemBarsStyle.Default, nav: SystemBarsStyle.Default });
  });
});
