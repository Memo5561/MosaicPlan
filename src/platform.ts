/**
 * Plattform-Anpassungen: Im Android-App-Paket (Capacitor) gibt es keine Browser-Downloads.
 * Dateien werden dort in „Dokumente/MosaicPlan“ gespeichert und zusätzlich über das Teilen-Menü angeboten.
 */
import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

export const isNative = () => Capacitor.isNativePlatform();

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export async function saveNative(blob: Blob, name: string): Promise<string> {
  const data = await blobToBase64(blob);
  let savedPath = '';
  try {
    await Filesystem.writeFile({ path: `MosaicPlan/${name}`, data, directory: Directory.Documents, recursive: true });
    savedPath = `Dokumente/MosaicPlan/${name}`;
  } catch {
    /* öffentlicher Ordner nicht beschreibbar – nur Teilen */
  }
  const cache = await Filesystem.writeFile({ path: name, data, directory: Directory.Cache, recursive: true });
  try {
    await Share.share({ title: name, files: [cache.uri], dialogTitle: name });
  } catch {
    /* Teilen abgebrochen */
  }
  return savedPath;
}
