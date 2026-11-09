# MosaicPlan – Stand der Verbesserungsarbeit und Fortsetzung

Unterbrochen am 09.11.2026 auf Wunsch des Nutzers („nächste Woche weitermachen, nichts darf verloren gehen“).
Alles, was nötig ist, um weiterzumachen, liegt in diesem Ordner und im Branch `ccr-e3c91906-ceq1vn`.

## Was bisher passiert ist

1. **Audit** (8 Fachprüfer, jede Feststellung von 2 Gegenprüfern verifiziert):
   95 Feststellungen, 92 bestätigt, 3 verworfen. Daraus ein Plan mit **7 Wellen / 33 Arbeitspaketen**.
   → `audit-ergebnis.json` (alle bestätigten/verworfenen Feststellungen + Plan), `audit-workflow.js`
2. **Wellen 1–4: fertig.** Jede Welle wurde parallel umgesetzt, zusammengeführt, aus 4 Blickwinkeln
   gegengeprüft, alle bestätigten Review-Befunde behoben, alle Tests grün, gepusht.
   Letzter fertiger Stand: Commit `6cc6269` (755 Unit-Tests, alle Browser-Tests grün).
   Berichte (Abweichungen vom Plan, neue Schnittstellen, Entscheidungen): `plan/wave1-report.json` … `plan/wave4-report.json`

| Welle | Inhalt | Status |
| --- | --- | --- |
| 1 | Datensicherheit (Speichern, atomare Berechnung, Integrität), baubare Schnitte, 4× schnellere Analyse, korrekte Materialsummen, Touch-Sicherheit, Material-CSV | ✅ fertig |
| 2 | Neuberechnungs-Schutz, Speicheranzeige, Schritt-Navigation, Android (Zurück-Taste, Speichern, Ränder), ehrliche Farbnamen, Fugen-Vorschau, Design, Foto-Import | ✅ fertig |
| 3 | Farbqualität, Live-Vorschau, Freiform-Editor, Gesichts-Hinweise, Viewer (Lineale, Vergleich, Malen), PDF-Grundlagen, Projekt-Export mit Materialien | ✅ fertig |
| 4 | Schnitte gezielt, Akzent-/Pflichtfarben, Konturen, Verlege-Arbeitsplatz, Fortschritts-Engine, PDF-Blattaufteilung, Offline-Gesichtserkennung | ✅ fertig |
| 5 | Rückgängig/Wiederholen, Statistik-Engine, Viewer-Performance, PDF-Inhalt, Einkaufsliste, Zielfarben, PDF-Export-Schritt | ⏸ **unterbrochen** (siehe unten) |
| 6 | Abweichungskarte & Sammelbearbeitung, feine Steine in Kaufgrößen, Farbmessung, Streaming-CSV, PDF-Abschluss | ⏳ offen |
| 7 | README/Grenzen, Gesamt-E2E | ⏳ offen |

## Welle 5 – Zwischenstand (NICHT im Branch, sondern im Bündel)

`welle5-zwischenstand.bundle` enthält die Arbeitszweige (Basis `6cc6269`):

| Zweig | Stand |
| --- | --- |
| `wp/w5-undo-editing` | fertig, einzeln grün (Typprüfung, Tests, Build, E2E) |
| `wp/w5-stats-engine` | fertig, einzeln grün |
| `wp/w5-viewer-performance` | fertig, einzeln grün |
| `wp/w5-pdf-content` | fertig, einzeln grün |
| `wp/w5-material-shopping` | fertig, einzeln grün |
| `wp/w5-target-colours` | **unvollständig** – WIP-Commit (Kern-Code begonnen, ungeprüft) |
| `w5-pdf-export-ui` | **nicht begonnen** |

Die fünf fertigen Pakete sind **noch nicht zusammengeführt und nicht gegengeprüft**.
Ihre Abschlussberichte: `plan/wave5-teilbericht.json`.

Zweige wiederherstellen:

```bash
git fetch docs/fortsetzung/welle5-zwischenstand.bundle 'refs/heads/wp/*:refs/heads/wp/*'
git branch --list 'wp/*'
```

## So geht es weiter

1. Umgebung vorbereiten (siehe unten), Zweige aus dem Bündel holen.
2. Welle 5 abschließen:
   - `w5-target-colours` fertigstellen (Briefing `plan/w5-target-colours.json`, WIP-Commit als Ausgangspunkt oder neu beginnen),
   - `w5-pdf-export-ui` umsetzen (Briefing `plan/w5-pdf-export-ui.json`),
   - alle sieben Zweige zusammenführen, Gesamtprüfung (Typprüfung, Tests, Build, alle `e2e/*.cjs`),
   - Review aus 4 Blickwinkeln (Korrektheit, Geometrie/Ehrlichkeit, UX Desktop+Handy, Integration), Befunde beheben.
3. Welle 6, dann Welle 7 (Briefings `plan/w6-*.json`, `plan/w7-docs-e2e.json`, Wellenliste `plan/waves.json`).
4. Neue APK bauen (siehe unten).

Automatisiert: `wellen-workflow.js` ist das verwendete Workflow-Skript (Umsetzung in parallelen Arbeitskopien →
Zusammenführen → Review → Fix). Es erwartet die Briefings unter `<scratchpad>/plan/` – entweder den Ordner
`docs/fortsetzung/plan` dorthin kopieren oder die Konstante `SP` im Skript anpassen. Aufruf mit
`args: {wave, ids, baseSha}`. Für Welle 5 nur die beiden offenen Pakete umsetzen lassen und die fünf fertigen
Zweige vorher bzw. im Zusammenführungsschritt mit einbeziehen.

Hinweis aus der bisherigen Arbeit: Eine Welle braucht ca. 3,5–4,5 Stunden Agentenzeit; das 5-Stunden-Nutzungslimit
wurde mehrfach erreicht – dann nach dem Zurücksetzen dieselbe Welle neu starten (bereits committete Zweige prüfen).

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
- Die zuletzt ausgelieferte APK (1.0) enthält noch **keine** der Verbesserungen aus den Wellen 1–4.
  Updates müssen mit demselben Schlüssel signiert werden, sonst geht beim Neuinstallieren der lokale Speicher verloren.
