# MosaicPlan – Professioneller Mosaik-Planer

Persönliche Web-App, die Fotos in **maßstabsgetreue Glas- und Keramikmosaike** umwandelt und einen
vollständigen **Stein-für-Stein-Verlege- und Produktionsplan** erzeugt: Position, Farbe, Größe, Form
und Schnittmaße jedes einzelnen Steins, Farblegende, Materialliste, Schnittvorlagen und druckbarer
PDF-Plan mit Anschlussmarken.

* Läuft im Browser auf PC, Tablet und Android-Handy (installierbar als PWA, „Zum Startbildschirm hinzufügen“).
* **Keine Cloud**: Fotos, Projekte und Materialien bleiben lokal im Browser (IndexedDB).
* **Offline nutzbar**: Nach dem ersten Laden funktionieren alle Kernfunktionen ohne Internet (Service Worker).
* Sprachen: **Deutsch** (Standard), Englisch, Türkisch.

## Starten

```bash
npm install
npm run dev          # Entwicklungsserver (http://localhost:5173)
npm run build        # Produktions-Build nach dist/
npx vite preview     # Build lokal ausliefern (inkl. Offline-Service-Worker)
```

Für die Nutzung auf Tablet/Handy den `dist/`-Ordner auf einem beliebigen statischen Webserver
(auch im Heimnetz) bereitstellen und im Browser „Zum Startbildschirm hinzufügen“ wählen.
Projekte lassen sich unter *Meine Projekte → Exportieren/Importieren* als Datei zwischen Geräten übertragen.

## Android-App (APK)

Die App wird mit Capacitor als echte Android-App verpackt (`android/`). Alle Dateien liegen im APK,
die App läuft vollständig offline; Daten bleiben im App-Speicher des Handys. PDF-, CSV- und Projektdateien
werden in *Dokumente/MosaicPlan* gespeichert (soweit Android das erlaubt) und zusätzlich über das Teilen-Menü angeboten.

Build (benötigt JDK 21 und Android SDK mit Plattform 36):

```bash
echo "sdk.dir=/pfad/zum/android-sdk" > android/local.properties
npm run android:sync
cd android && ./gradlew assembleRelease \
  -Pandroid.injected.signing.store.file=/pfad/mosaicplan-release.jks \
  -Pandroid.injected.signing.store.password=*** \
  -Pandroid.injected.signing.key.alias=mosaicplan \
  -Pandroid.injected.signing.key.password=***
# Ergebnis: android/app/build/outputs/apk/release/app-release.apk
```

Der Signierschlüssel ist bewusst **nicht** im Repository (öffentlich). Updates müssen mit demselben Schlüssel
signiert werden, sonst muss die App deinstalliert werden – dabei gehen lokal gespeicherte Projekte verloren
(vorher *Meine Projekte → Exportieren*).

## Arbeitsablauf (10 Schritte)

1. **Foto** – hochladen, zuschneiden (Seitenverhältnis = Mosaikfläche), drehen (90° + Feindrehung), spiegeln,
   Helligkeit, Kontrast, Sättigung, Schärfe, Details hervorheben, Hintergrund vereinfachen, Tonwerte/Weißabgleich.
2. **Bildgröße** – beliebige Breite × Höhe in mm/cm/m (keine Obergrenze außer Arbeitsspeicher; harte Grenze 40 Mio. Rasterpositionen).
   Randmodus: nur ganze Steine / Rand zuschneiden (rechts-unten) / symmetrisch zuschneiden.
3. **Steingröße** – 2 × 2 … 12 × 12 mm, rechteckig (z. B. 3 × 5, 4 × 8, 6 × 10, 8 × 12) oder frei.
4. **Fuge** – 0 / 0,5 / 1 / 1,5 / 2 / 3 mm oder frei; Fugenfarbe und -tiefe.
5. **Farben** – 8, 12, 16, 24, 32, 48, 64, 100, 150, 200 oder frei; Quelle: automatisch (K-Means),
   automatisch → eigene Materialien, nur eigene Materialien, eigene Palette. CIEDE2000 oder CIE76, optional Dithering.
   Automatische Farbnamen folgen der Sprache (auch in PDF, CSV und Steindetail); eingetippte Namen bleiben wörtlich.
   Die Abweichung je Farbe wird mit der ΔE-Formel der Berechnung angezeigt; eingestuft („> 5 deutlich“) nur bei CIEDE2000.
   Eine eigene Palette behält beim Berechnen Reihenfolge und Farbnummern (auch Lücken nach dem Entfernen). Während
   einer Berechnung sind Farbquelle und Palette gesperrt – auch in anderen Ansichten und Tabs; wird die gespeicherte
   eigene Palette trotzdem geändert, bleibt eine Ergänzung erhalten (Projekt gilt als geändert), eine Verkürzung
   verwirft das Ergebnis mit Meldung (nie falsche Farben).
6. **Steinformen** – Dreiecke (Diagonalschnitt), Kantenschnitte (Trapez/Dreieck/Rechteck/individuell),
   feinere Steine 2×2/3×3 in Detailbereichen, Gesichts-/Detailbereiche markieren, Hauttonschutz.
7. **Berechnen** – im Web Worker, kachelweise (64 × 64 Zellen), mit Fortschritt und Abbruch. Gehen beim Neuberechnen
   verlegte Steine, manuelle Änderungen oder bearbeitete Palettenfarben (Name, Farbton, Material – in den Modi
   „automatisch“ und „Materialien“ wird die Palette neu erstellt) verloren, fragt die App vorher nach (mit
   Sicherungskopie). Während der Berechnung ist das bisherige Mosaik gesperrt (Verlegemodus, „Abschnitt fertig“,
   Steine ändern); wurde trotzdem daran gearbeitet, wird das Ergebnis nicht still übernommen, sondern wartet auf
   eine Entscheidung (Sicherungskopie und übernehmen, ohne Sicherung übernehmen, Ergebnis verwerfen).
8. **Vorschau** – realistische Glas-/Keramikdarstellung, Zoom/Pan (Maus, Touch, Pinch), Farbnummern,
   Stein anklicken → Detailfenster mit Position, Koordinaten, Farbe, Größe, Form, Schnittanweisung,
   Schnittvorlage, Nachbarn; Farbe/Form einzeln ändern (Statistik aktualisiert sich automatisch).
   „Heller“/„Dunkler“ wählt die nächste Palettenfarbe gleichen Farbtons, sonst die ähnlichste hellere/dunklere
   Palettenfarbe (gekennzeichnet „etwas anderer Farbton“) – passend zu ▲/▼ in der Farbreihe, nie erfunden.
   Werkzeuge unter dem Mosaik: Abweichung zum Foto (Karte und Liste; ΔE in Worten: kaum sichtbar < 2, erkennbar 2–5,
   deutlich 5–10, stark > 10 – Wortlaut in `src/ui/deWords.ts`), Bereich bearbeiten, Bild (PNG). Das Steindetail
   zeigt (bei offenem Werkzeug „Abweichung“ oder eingeschalteter Karte) Fotofarbe, Abweichung und „Nächste Farbe
   übernehmen“; am Handy ist es ein niedrigeres Blatt, der Stein liegt
   sichtbar darüber. „Form zurücksetzen“ färbt jeden ganzen Stein mit der Palettenfarbe nächst dem flächengewichteten
   Fotomittel der Zelle (ohne Fotoreferenz: Farbe mit der größten Fläche); „Heller/Dunkler“ kennzeichnet Stufen über
   ΔE 8 als „großer Sprung“, jede Zeile ist abwählbar (`src/core/batch.ts`).
9. **Verlegeplan** – Abschnitte (A1, A2 … nach max. Größe oder Anzahl), Verlegemodus (Antippen bzw. Anklicken = verlegt),
   Abschnitt fertig markieren, Fortschritt in %, Materialberechnung, CSV-Export aller Koordinaten.
   „Material & Einkauf“: „zu kaufen“ nur für Materialien mit erfasstem Bestand – fehlt der Bestand bei einem Material
   (oder gibt es Farben ohne Material), ist die Summe ausdrücklich eine Teilsumme („unvollständig“, auch in der CSV).
10. **PDF-Export** – A4/A3/A2/A1/A0/individuell, Hoch-/Querformat, Maßstab 1:1/2:1/3:1/4:1/an Seite anpassen.

## Geometrie und Maße (verbindliche Definitionen)

* **Projektursprung (0 | 0)**: obere linke Außenkante des ersten Steins **A001**. X nach rechts, Y nach unten, alle Maße in mm.
* **Positionsbezeichnung**: Zeile als Buchstabe(n) (A … Z, AA, AB …), Spalte als Zahl (001 …), z. B. `A001`, `A002`.
  Mehrteilige Zellen: `A001-1`, `A001-2`. Bei 5-mm-Steinen mit 1 mm Fuge liegt A002 bei X = 6 mm.
* **Fugen**: Bei *n* Steinen der Breite *w* und Fuge *g* ist die belegte Länge `n·w + (n−1)·g`.
  Fugen liegen nur zwischen Steinen. Die Gesamtgröße wird nie als „Anzahl × Steinbreite“ berechnet.
* **Randsteine**: Im Modus „Rand zuschneiden“ erhalten Randspalten/-zeilen exakt berechnete Breiten, damit
  die gewünschte Länge genau erreicht wird; ist das nicht möglich (Mindestschnittbreite), wird das Restmaß angezeigt.
* **Schnitte**: Jedes geschnittene Teil ist ein exakt berechnetes Polygon (Halbebenen-Clipping mit halber
  Fugenbreite zu beiden Seiten der Schnittlinie). Daraus ergeben sich Form (Klassifizierung aus der Geometrie),
  Außenmaße, Fläche, Kantenlängen, Innenwinkel und die Schnittlinien im Rohstein (Koordinaten ab der oberen
  linken Rohsteinecke). Maße werden auf 0,1 mm gerundet angezeigt.
* **Mindestbreite eines Schnittteils** (Schritt Steinformen): Jedes geschnittene Teil muss an seiner schmalsten Stelle
  (minimale Kaliberweite) mindestens so breit sein **und** ein Inkreismaß (4 · Fläche ÷ Umfang; bei Dreiecken der
  Inkreisdurchmesser) von mindestens diesem Wert haben – bei Dreiecken ist das die strengere Bedingung. Hinweise nennen
  immer die gemessenen Werte (z. B. „Inkreismaß 1,93 mm < 2 mm (schmalste Stelle 2,33 mm)“).
* **Formempfehlung vs. Schnittvorlage**: Formen, die sinnvoll wären, aber deaktiviert sind, werden nur als
  „Empfehlung – nicht berechnet“ markiert – und nur, wenn ihre Teile die Mindestbreite erfüllen. Nur aktivierte Formen
  erzeugen berechnete Schnittvorlagen.
* **Schnittlinien**: durchgehende Schnitte (rot, ritzen und brechen) und Einschnitte bis zur Innenecke nicht-konvexer
  Teile (orange gepunktet, nicht durchritzen) sind in App und PDF gleich gezeichnet und gleich nummeriert.
* **Zählung**: Es wird über Rasterzellen → Teilstücke iteriert; jeder Stein wird genau einmal gezählt.
  Die Tests prüfen `Steinfläche + Fugenfläche = Gesamtfläche`, eindeutige IDs und Summen je Farbe/Form/Größe/Abschnitt.
* **Materialbedarf**: Rohsteine je Farbe aus der Ausbeute je Schnittart (ganzer Stein 1, Diagonaldreieck 2 je Rohstein,
  Rechtecke so viele wie hineinpassen, sonstige Formen 1), aufgerundet; Reserve 5/10/15/20 % oder frei;
  Verschnitt = Rohsteinfläche − Steinfläche. Rohsteinmaß = Maß des zugeordneten Materials, sonst Rastermaß.
  Packungen, Bestand, Fehlbestand und Kosten werden **je Material** gezählt (Einkaufsliste in App und PDF): ein Material,
  das mehreren Farben zugeordnet ist, wird einmal gekauft; die Summe der Kosten ist die angezeigte Materialkosten-Summe.
  Teile ohne Fläche (ältere Projekte: Fuge breiter als der Stein) sind keine Steine und werden nicht gezählt; solche
  Zellen werden beim Öffnen in ganze Steine umgewandelt (mit Hinweis).
  Fugenmasse = Fugenfläche × Fugentiefe × 1,6 kg/l (**Schätzwert**).
  Freiformsteine aus älteren oder importierten Projekten, deren Teile sich überlappen (exakte Schnittfläche), werden
  nicht still umgewandelt, sondern im Projektkopf mit ihrer Position gemeldet; Stein-/Fugenfläche und Fugenmasse gelten
  dann als „nicht berechenbar“, und der PDF-Plan wird erst nach der Korrektur im Freiform-Editor erstellt.

## PDF-Inhalt

Deckblatt · Originalfoto · Mosaikvorschau · Gesamtübersicht mit Abschnitten · je Abschnitt: Deckblatt mit Position,
Anschlüssen, Farblegende und Stückzahlen · nummerierte, maßstäbliche Verlegeblätter (Raster, Farbcodes, Formen,
Zeilen-/Spaltenbeschriftung, mm-Lineal in Projektkoordinaten, Passkreuze auf Fugenmitte, Anschlusslinien mit
Blatt-/Abschnittsverweis, 50/100-mm-Kontrollstrecke) · Farblegende · Materialliste mit Bedarf je Farbe und
Einkaufsliste je Material · Anzahl je Form und Größe ·
Schnittvorlagen (vergrößert + 1:1, Kantenmaße, Winkel, Schnittlinien) · Koordinatenlisten · Seitenzahlen.
Große Abschnitte werden automatisch auf mehrere Blätter verteilt; Blattgrenzen liegen auf Rasterlinien.
Beim Druck **„Tatsächliche Größe / 100 %“** wählen und die Kontrollstrecke nachmessen.

Abschnittsauswahl und **Export in Teilen**: Schnittvorlagen enthalten nur die Vorlagen der exportierten Abschnitte
(Nummern T1 … bleiben global, Stückzahlen gelten für die exportierten Abschnitte, das ganze Mosaik steht daneben).
Jedes Teil-PDF nennt „Teil k von n“ auf dem Deckblatt und in jeder Fußzeile; die Seitenzahl jedes Teils wird mit
seinen Abschnitten gemessen (`usePartFacts`, wie eine Einzeldatei derselben Abschnitte). Fertige Dateien gehören
zu allem, was im PDF steht (Optionen, Raster, Palette, Materialien, Einstellungen, Name, Foto, Sprache – `pdfFileSig`);
der Vermerk „Export läuft“ (`mp.pdfInFlight`) trägt Tab-Kennung und Lebenszeichen bzw. eine Web-Sperre, damit ein
zweiter Tab einen laufenden Export nie für einen Absturz hält. Dateinamen sind ASCII (`safeFileName`: ä → ae, ş → s …)
mit dem Wort der Oberflächensprache (`…_verlegeplan.pdf`, `…_laying-plan.pdf`, `…_doseme-plani.pdf`).

## Technik

React 19 + TypeScript, Vite, Canvas 2D (virtuelles Rendering nur sichtbarer Steine; Übersichtsbitmap beim
Herauszoomen), Web Worker für Berechnung/Statistik/PDF/CSV, IndexedDB, jsPDF (Schrift DejaVu Sans eingebettet,
damit Türkisch korrekt gedruckt wird), vite-plugin-pwa (Workbox) für Offline-Betrieb.

Rechenkern (`src/core`, ohne DOM, vollständig getestet):
`color.ts` (sRGB ⇄ CIELAB D65, CIE76, CIEDE2000), `kmeans.ts` (gewichtetes K-Means++ in Lab),
`imageOps.ts` (Gauß/Box-Filter, Sobel, Unschärfemaske, Tonwerte, Weißabgleich, Hintergrundvereinfachung),
`layout.ts` (Raster mit Fugen, Randzuschnitt, Abschnitte, IDs), `pieces.ts` (Polygone, Schnittanalyse),
`mosaic.ts` (Bildanalyse je Zelle, Formwahl, Palette, Zuordnung), `stats.ts`, `edits.ts`, `pdf.ts`, `csv.ts`, `render.ts`.

## Tests

```bash
npm test                                   # 53 Unit-/Integrationstests (Vitest)
npm run build && npx vite preview --port 4173 &
npm run e2e                                # Browser-Test (Playwright/Chromium), 17 Prüfungen
```

Geprüft werden u. a.: CIEDE2000 gegen die Referenzdaten von Sharma et al., Fugen in der Gesamtgröße,
exakte Randzuschnitte, eindeutige IDs, Steine innerhalb ihrer Zelle ohne Überlappung mit Mindestabstand = Fuge,
Stückzahlen je Farbe/Form/Größe/Abschnitt, Flächenbilanz, verlustfreies Speichern/Laden,
**PDF = Berechnung** (Anzahl der gezeichneten Steine je Farbe auf den Verlegeblättern),
Schnittvorlagen-Zuordnung, Großformat (200 × 100 cm mit 55.778 Positionen, 1000 × 500 cm mit 2 Mio. Positionen),
sowie im Browser: Berechnung, Steindetail, Farb- und Formänderung (Dreieck mit Schnittvorlage), Verlegemodus, Abschnitt fertig, Materialberechnung,
PDF-Download, **Projekt und Fortschritt nach Neustart erhalten**, Sprachen, Material anlegen, **Offline-Start**, Handy-Ansicht.

Testprojekte (Startseite → „Testprojekte“): Menschenporträt, Landschaft, Tier (Katze), Stadtbild.
Die Testbilder sind synthetisch erzeugt (`scripts/svg/*.svg` → `scripts/render-svgs.cjs`), keine echten Fotos.

## Status und Einschränkungen (ehrlich)

| Bereich | Status |
| --- | --- |
| Fotoimport, Zuschnitt, Drehen, Bildoptimierung | fertig |
| Bildanalyse CIELAB/ΔE, K-Means | fertig |
| Mosaikberechnung, Steingrößen 2–12 mm + individuell, Projektmaße, Fugen | fertig |
| Farblegende, Farbverwaltung, Materialdatenbank, Abgleich mit eigenen Materialien | fertig |
| Stein-für-Stein-Positionierung, Einzelstein-Ansicht und -Bearbeitung | fertig |
| Großformat-Aufteilung in Abschnitte, Fortschritt | fertig |
| Materialberechnung, PDF-Verlegeplan, CSV | fertig |
| Individuelle Schnittkonturen | fertig für Dreieck/Trapez/Rechteck/Kantenschnitt (automatisch) und Freiform je Rasterzelle (manuell) |
| Projektverwaltung, Export/Import, Offline | fertig |
| **Rauten** | **unvollständig**: werden erkannt/klassifiziert und können per Freiform gezeichnet werden; ein automatisches Rautenraster gibt es nicht |
| **Gemischte Steingrößen** | nur als k×k-Unterteilung (2×2, 3×3) des Grundrasters; frei kombinierbare Zonen mit eigenem Raster sind **nicht** umgesetzt |
| **Gesichtserkennung** | offline mit pico.js (Vorschläge zum Übernehmen/Verwerfen; Augenpartie geschätzt): nur frontale, fotografierte menschliche Gesichter – keine Profile, Tiere, sehr kleinen oder gezeichneten/gemalten Gesichter (z. B. das Beispielporträt); dann von Hand markieren |
| **Hintergrund vereinfachen** | heuristisch über Kantendichte (keine KI-Segmentierung) |
| **OpenCV** | **nicht verwendet**: die benötigten Verfahren (Filter, Sobel, Unschärfemaske, K-Means) sind in TypeScript implementiert und getestet; opencv.js (~8–10 MB WASM) wäre für Handy/Offline unverhältnismäßig |
| Freiform | Konturen bleiben innerhalb einer Rasterzelle; zellübergreifende Freiformsteine sind nicht möglich |
| Kantenschnitte | Winkel in 15°-Schritten, Versatz im 0,5-mm-Raster (bewusst, damit sich gleiche Schnittvorlagen wiederholen) |
| Rückgängig/Wiederholen | für Farbe, Form und Freiform eines Steins, Verlegefortschritt und Palettenänderungen in einem gemeinsamen Verlauf (Strg+Z / Strg+Umschalt+Z / Strg+Y; höchstens 200 Schritte bzw. 32 MB); gilt nur, solange das Projekt geöffnet ist – Neuladen und Neuberechnen leeren den Verlauf |
| Farbwerte der Materialien | werden vom Benutzer eingegeben (HEX oder Pipette); keine Kamerakalibrierung |
| Sehr große Projekte | Berechnung mit mehreren Millionen Positionen funktioniert (getestet bis 2 Mio.); Speicherbedarf und PDF-Umfang steigen entsprechend – große PDFs abschnittsweise exportieren, vollständige Koordinaten per CSV |
