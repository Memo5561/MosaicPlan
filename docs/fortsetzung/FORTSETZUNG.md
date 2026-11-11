# MosaicPlan – Stand der Verbesserungsarbeit und Fortsetzung

Stand 11.11.2026: alle 7 Wellen fertig, APK 2.0 (versionCode 2) gebaut und ausgeliefert.
Alles, was nötig ist, um weiterzumachen, liegt in diesem Ordner und im Branch `ccr-e3c91906-ceq1vn`.

## Was bisher passiert ist

1. **Audit** (8 Fachprüfer, jede Feststellung von 2 Gegenprüfern verifiziert):
   95 Feststellungen, 92 bestätigt, 3 verworfen. Daraus ein Plan mit **7 Wellen / 33 Arbeitspaketen**.
   → `audit-ergebnis.json` (alle bestätigten/verworfenen Feststellungen + Plan), `audit-workflow.js`
2. **Wellen 1–4: fertig.** Jede Welle wurde parallel umgesetzt, zusammengeführt, aus 4 Blickwinkeln
   gegengeprüft, alle bestätigten Review-Befunde behoben, alle Tests grün, gepusht.
   Berichte (Abweichungen vom Plan, neue Schnittstellen, Entscheidungen): `plan/wave1-report.json` … `plan/wave4-report.json`
3. **Welle 5: alle 7 Pakete umgesetzt und zusammengeführt** (Commit `5548d5b`, gepusht).
   Typprüfung sauber, 941 Unit-Tests grün, Build in Ordnung.
   Berichte: `plan/wave5a-report.json` (5 Pakete), `plan/wave5b-report.json` (2 Pakete + Integration Teil 1).

| Welle | Inhalt | Status |
| --- | --- | --- |
| 1 | Datensicherheit (Speichern, atomare Berechnung, Integrität), baubare Schnitte, 4× schnellere Analyse, korrekte Materialsummen, Touch-Sicherheit, Material-CSV | ✅ fertig |
| 2 | Neuberechnungs-Schutz, Speicheranzeige, Schritt-Navigation, Android (Zurück-Taste, Speichern, Ränder), ehrliche Farbnamen, Fugen-Vorschau, Design, Foto-Import | ✅ fertig |
| 3 | Farbqualität, Live-Vorschau, Freiform-Editor, Gesichts-Hinweise, Viewer (Lineale, Vergleich, Malen), PDF-Grundlagen, Projekt-Export mit Materialien | ✅ fertig |
| 4 | Schnitte gezielt, Akzent-/Pflichtfarben, Konturen, Verlege-Arbeitsplatz, Fortschritts-Engine, PDF-Blattaufteilung, Offline-Gesichtserkennung | ✅ fertig |
| 5 | Rückgängig/Wiederholen, Statistik-Engine, Viewer-Performance, PDF-Inhalt, Einkaufsliste, Zielfarben, PDF-Export-Schritt | ✅ fertig (gegengeprüft, 16 Befunde behoben; `plan/wave5c-report.json`) |
| 6 | Abweichungskarte & Sammelbearbeitung, feine Steine in Kaufgrößen, Farbmessung, Streaming-CSV, PDF-Abschluss | ✅ fertig (gegengeprüft, 16 Befunde behoben; `plan/wave6-report.json`) |
| 7 | README/Grenzen, Gesamt-E2E | ✅ fertig (README mit allen Grenzen, `node e2e/run-e2e.cjs` startet alle E2E-Skripte) |

## So geht es weiter

1. Umgebung vorbereiten (siehe unten).
2. Welle 7 (Briefing `plan/w7-docs-e2e.json`, Wellenliste `plan/waves.json`).
3. Neue APK bauen (siehe unten).

Automatisiert: `wellen-workflow.js` ist das zuletzt verwendete Workflow-Skript (optional bereits fertige Zweige
zusammenführen → Umsetzung in parallelen Arbeitskopien → Zusammenführen → Review → Fix). Es erwartet die Briefings
unter `<scratchpad>/plan/` – entweder den Ordner `docs/fortsetzung/plan` dorthin kopieren oder die Konstante `SP`
im Skript anpassen. Aufruf mit `args: {wave, ids, baseSha}`. Für den Abschluss von Welle 5 genügen die Phasen
Review → Verify → Fix mit `baseSha = 6cc6269`.

Hinweis aus der bisherigen Arbeit: Eine Welle braucht ca. 3,5–4,5 Stunden Agentenzeit; das 5-Stunden-Nutzungslimit
wurde mehrfach erreicht – dann nach dem Zurücksetzen an derselben Stelle fortsetzen (Zustand im Branch prüfen).

## Umgebung

```bash
npm install                       # Node 22
npm run typecheck && npm test && npm run build
npx vite preview --port 4173 &    # für Browser-Tests
node e2e/run-e2e.cjs http://localhost:4173/ /tmp/e2e
for f in e2e/w*.e2e.cjs; do node "$f" http://localhost:4173/ /tmp/e2e; done
```

### Android-APK bauen

- JDK 21, Android SDK: `sdkmanager "platforms;android-36" "build-tools;36.0.0" "platform-tools"`
- `echo "sdk.dir=/pfad/zum/android-sdk" > android/local.properties`
- `npm run android:sync`
- In der Cloud-Umgebung lieferte Maven Central HTTP 429 – dann ein Gradle-Init-Skript verwenden, das
  `repo.maven.apache.org` durch `https://maven-central.storage-download.googleapis.com/maven2/` ersetzt
  (`./gradlew -I mirror.gradle …`).
- Signieren mit dem Schlüssel aus `MosaicPlan-Signierschluessel.zip` (beim Nutzer, **nicht** im öffentlichen Repository):
  `./gradlew assembleRelease -Pandroid.injected.signing.store.file=… -Pandroid.injected.signing.store.password=… -Pandroid.injected.signing.key.alias=mosaicplan -Pandroid.injected.signing.key.password=…`
- Die zuletzt ausgelieferte APK ist 2.0 (versionCode 2) mit allen Verbesserungen; nächstes Update: versionCode erhöhen.
  Updates müssen mit demselben Schlüssel signiert werden, sonst geht beim Neuinstallieren der lokale Speicher verloren.
