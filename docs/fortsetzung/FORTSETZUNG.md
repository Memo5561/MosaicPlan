# MosaicPlan – Stand der Verbesserungsarbeit und Fortsetzung

Zuletzt angehalten am 10.11.2026 auf Wunsch des Nutzers („Stopp“). Zuvor am 09.11.2026 unterbrochen und am 10.11. fortgesetzt.
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
| 5 | Rückgängig/Wiederholen, Statistik-Engine, Viewer-Performance, PDF-Inhalt, Einkaufsliste, Zielfarben, PDF-Export-Schritt | 🟡 **umgesetzt und zusammengeführt, aber noch nicht gegengeprüft** (siehe unten) |
| 6 | Abweichungskarte & Sammelbearbeitung, feine Steine in Kaufgrößen, Farbmessung, Streaming-CSV, PDF-Abschluss | ⏳ offen |
| 7 | README/Grenzen, Gesamt-E2E | ⏳ offen |

## Welle 5 – was noch fehlt

Der Code aller sieben Pakete ist im Branch. **Noch nicht erledigt:**

1. Vollständiger Browser-Testlauf nach der letzten Zusammenführung (`e2e/run-e2e.cjs` und alle `e2e/w*.e2e.cjs`).
   Nach „Integration Teil 1“ (5 Pakete) waren alle grün; nach „Integration Teil 2“ (`5548d5b`) wurde der Lauf
   durch das Nutzungslimit bzw. den Stopp nicht mehr abgeschlossen.
2. Review der gesamten Welle (Diff `6cc6269..HEAD`, ohne `docs/fortsetzung`) aus 4 Blickwinkeln:
   Korrektheit, Geometrie/Ehrlichkeit, UX Desktop + Handy, Integration – je Befund ein Gegenprüfer.
3. Bestätigte Befunde beheben, alle Prüfungen grün, pushen.

Bis dahin gilt Welle 5 als **ungeprüft**: Die Funktionen sind da, aber die Gegenprüfung, die in den Wellen 1–4
jeweils 17–24 echte Probleme gefunden hat, steht noch aus.

## So geht es weiter

1. Umgebung vorbereiten (siehe unten).
2. Welle 5 abschließen (Punkte 1–3 oben).
3. Welle 6, dann Welle 7 (Briefings `plan/w6-*.json`, `plan/w7-docs-e2e.json`, Wellenliste `plan/waves.json`).
4. Neue APK bauen (siehe unten).

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
- Die zuletzt ausgelieferte APK (1.0) enthält noch **keine** der Verbesserungen aus den Wellen 1–5.
  Updates müssen mit demselben Schlüssel signiert werden, sonst geht beim Neuinstallieren der lokale Speicher verloren.
