# MosaicPlan – Professioneller Mosaik-Planer

Persönliche Web-App, die Fotos in **maßstabsgetreue Glas- und Keramikmosaike** umwandelt und einen
vollständigen **Stein-für-Stein-Verlege- und Produktionsplan** erzeugt: Position, Farbe, Größe, Form
und Schnittmaße jedes einzelnen Steins, Farblegende, Materialliste, Schnittvorlagen und druckbarer
PDF-Plan mit Anschlussmarken.

* Läuft im Browser auf PC, Tablet und Android-Handy (installierbar als PWA, „Zum Startbildschirm hinzufügen“).
* **Keine Cloud**: Fotos, Projekte und Materialien bleiben lokal im Browser (IndexedDB).
* **Offline nutzbar**: Nach dem ersten Laden funktionieren alle Kernfunktionen ohne Internet (Service Worker).
* Sprachen: **Deutsch** (Standard), Englisch, Türkisch.
* Mindestens Chrome/Edge 111, Firefox 114, Safari 16.4; im APK Android System WebView 111 (ältere Browser erhalten
  eine Erklärung statt einer leeren Seite, das APK verweist auf das WebView-Update).

Was fertig ist, was fehlt und was nur im Quelltext bzw. im simulierten APK geprüft wurde, steht ehrlich in
[Status und Einschränkungen](#status-und-einschränkungen-ehrlich).

## Starten

```bash
npm install
npm run dev          # Entwicklungsserver (http://localhost:5173)
npm run build        # Produktions-Build nach dist/
npx vite preview     # Build lokal ausliefern (inkl. Offline-Service-Worker)
```

Für die Nutzung auf Tablet/Handy den `dist/`-Ordner auf einem beliebigen statischen Webserver
(auch im Heimnetz) bereitstellen und im Browser „Zum Startbildschirm hinzufügen“ wählen.
Projekte lassen sich unter *Meine Projekte → Exportieren/Importieren* als Datei (`*.mosaicplan.json`) zwischen
Geräten übertragen (siehe [Projektdatei](#projektdatei-export-und-import)).

## Android-App (APK)

Die App wird mit Capacitor als echte Android-App verpackt (`android/`). Alle Dateien liegen im APK,
die App läuft vollständig offline; Daten bleiben im App-Speicher des Handys.

* **Speichern**: PDF-, CSV-, PNG- und Projektdateien werden erst in den App-Cache geschrieben und dann nach
  *Documents/MosaicPlan* kopiert; „Gespeichert: …“ erscheint nur, wenn die Datei dort mit der richtigen Größe
  bestätigt wurde (bei einem Namenskonflikt einmal mit Uhrzeit-Zusatz). Klappt das nicht (z. B. Speicherzugriff
  unter Android 10 abgelehnt), nennt die App den Grund und öffnet sofort das Teilen-Menü; „Erneut teilen“ bleibt
  danach verfügbar.
* **Zurück-Taste**: schließt zuerst einen offenen Dialog, dann geht sie zur vorigen Ansicht; auf der Startseite
  wird die App minimiert (nicht beendet).
* **Systemleisten** (Edge-to-Edge, Android 15/16): helle Statusleisten-Symbole über der dunklen Kopfleiste, dunkle
  Navigationsleisten-Symbole über der hellen Seite, Dialoge und Seitenende berücksichtigen die Safe-Area-Abstände.

Diese drei Punkte sind **nicht auf einem echten Gerät geprüft** – nur im Quelltext, in Unit-Tests und im Browser
mit einer nachgebauten Capacitor-Brücke (`e2e/w2-android-platform.e2e.cjs`).

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
4. **Fuge** – 0 / 0,5 / 1 / 1,5 / 2 / 3 mm oder frei; Fugenfarbe (auch als HEX) und -tiefe.
   **Fugenfarben-Empfehlung (Modell-Schätzung)**: Für Weiß, Hellgrau/Beige, Silbergrau, Zementgrau, Dunkelgrau,
   Anthrazit, Schwarz und die eigene Farbe schätzt die App die Fernwirkung (Steine und Fuge flächengewichtet in
   linearem Licht gemischt, Mosaik und Foto gleich unscharf, ΔE00 Mittelwert und 95 %) – auf Grundlage des
   berechneten Mosaiks oder, vorher, idealer ganzer Steine in Fotofarbe. Die Empfehlung wird nur mit „Übernehmen“
   gesetzt, nie still. Herausgezoomte Ansicht, PDF-Übersicht und Vorschaubilder zeigen die Mischung mit der Fuge.
   Fugenmasse trocknet meist heller auf – am besten eine Probe messen und den HEX-Wert eintragen.
5. **Farben** – 8, 12, 16, 24, 32, 48, 64, 100, 150, 200 oder frei; Quelle: automatisch (K-Means),
   automatisch → eigene Materialien, nur eigene Materialien, eigene Palette. CIEDE2000 oder CIE76.
   **Farbübergänge mischen (Dithering, 0–100 %, Standard 50 %)** – ein bewusster Kompromiss: höher ergibt weichere
   Verläufe (Haut, Himmel) und aus Betrachtungsabstand ein genaueres Bild, aber mehr Farbwechsel beim Legen und eine
   leicht höhere Abweichung je Stein; 0 % ergibt ruhige, einfarbige Flächen. Gemischt wird nur mit Farben, die der
   Fotofarbe des Steins fast so nahe kommen wie die beste (höchstens ΔE 3 mehr) – keine fremden Farbtupfer;
   geschnittene und feinere Steine erhalten immer die ähnlichste Farbe.
   **Pflichtfarben** (genau dieser HEX-Wert – bzw. bei „automatisch → eigene Materialien“ das nächste Material – kommt in
   die Palette; erhält er keinen Stein, fällt er wie jede unbenutzte Farbe weg, mit Hinweis), **Fehlende Akzentfarben**
   (Gruppen ab 2 Steinen, z. B. Pupillen, deren Farbe deutlich vom Foto abweicht; Vorschlag = gemessenes Fotomittel)
   und „Fehlende Farben“ (Zieltöne zum Nachkaufen) sind Vorschläge zum Übernehmen. Mit Feinsteinen (Schritt 6)
   bekommt jede Farbe optional ein eigenes **Feinstein-Material** (automatisch: nächstes Material dieser Größe nach ΔE00).
   Automatische Farbnamen folgen der Sprache (auch in PDF, CSV und Steindetail); eingetippte Namen bleiben wörtlich.
   Die Abweichung je Farbe wird mit der ΔE-Formel der Berechnung angezeigt; eingestuft („> 5 deutlich“) nur bei CIEDE2000.
   Eine eigene Palette behält beim Berechnen Reihenfolge und Farbnummern (auch Lücken nach dem Entfernen). Während
   einer Berechnung sind Farbquelle und Palette gesperrt – auch in anderen Ansichten und Tabs; wird die gespeicherte
   eigene Palette trotzdem geändert, bleibt eine Ergänzung erhalten (Projekt gilt als geändert), eine Verkürzung
   verwirft das Ergebnis mit Meldung (nie falsche Farben).
6. **Steinformen** – Dreiecke (Diagonalschnitt), Kantenschnitte (Trapez/Dreieck/Rechteck/individuell, optional
   „Konturen durchgehend“), Mindestbreite eines Schnittteils, Hauttonschutz,
   „Schnitte verteilen“ (Schnitte außerhalb markierter Bereiche teurer machen).
   * **Gesichts-, Detail- und Feinbereiche** von Hand zeichnen (am Handy erst nach „Bereich zeichnen“), verschieben
     und in der Größe ändern. **Gesichtsvorschläge**: offline mit pico.js (Kaskade ≈ 240 KB, vorab zwischengespeichert),
     nur frontale, fotografierte menschliche Gesichter; jeder Vorschlag (mit Konfidenz als Richtwert und geschätzter
     Augenpartie) wird erst mit „Übernehmen“ zum Bereich – nie still angewendet.
   * **Feinere Steine (Stufe 1)**: k×k-Teilung (2×2 oder 3×3) einer Rasterzelle. Die Auswahl „Feinstein-Größe“ zeigt
     das entstehende Maß `(Steinmaß + Fuge) / k − Fuge` und ob es ein ganzes Millimetermaß ist (z. B. 10 mm + 2 mm
     Fuge → 4 mm bei 2×2; 8 mm + 1 mm → 2 mm bei 3×3). In **Feinbereichen** wird jede Zelle, deren Mitte darin liegt,
     als Feinsteine berechnet – sofern jeder Teilstein genau das Feinsteinmaß hat (gekürzte Randsteine nicht) und die
     Mindestbreite erfüllt; optional werden feinere Steine in Gesichts-/Detailbereichen bevorzugt. Schritt 7 zählt
     nach der Berechnung exakt, wie viele Zellen es wurden.
   * **Live-Vorschau** (Schritte 2–7): exakte Berechnung aller Steine mit den aktuellen
     Einstellungen, selbsttätig bis 60.000 Rasterpositionen (30.000 auf langsamen Geräten) und solange die letzte
     Vorschau unter 1,5 s blieb, sonst auf Knopfdruck mit geschätzter Dauer (Richtwert). Gespeichert wird sie erst mit
     „Vorschau übernehmen“ (Schritt 7) bzw. beim Öffnen von Schritt 8; bis dahin heißt sie „Vorschau – noch nicht übernommen“.
7. **Berechnen** – im Web Worker, kachelweise (64 × 64 Zellen), mit Fortschritt und Abbruch. Bei gleichem Raster
   bleiben nachweislich unveränderte Steine verlegt (geänderte werden wieder offen und gezählt gemeldet). Gehen beim Neuberechnen
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
   ΔE 8 als „großer Sprung“, jede Zeile ist abwählbar (`src/core/batch.ts`). Eine Bereichsbearbeitung (Farbe A → B,
   Heller/Dunkler, Form zurücksetzen) zeigt vorher einen Probelauf und ist ein einziger Verlaufsschritt.
   **Rückgängig/Wiederholen** (Strg+Z / Strg+Umschalt+Z / Strg+Y, am Handy beschriftete Knöpfe) für Farbe, Form,
   Freiform, Verlegestatus und Palette – siehe Einschränkungen. Das Vergleichsfoto wird mit dem Mosaik gespeichert
   („Referenz neu erzeugen“, wenn es fehlt).
9. **Verlegeplan** – Abschnitte (A1, A2 … nach max. Größe oder Anzahl; Vorgaben „passend zum Papier“: 1 Blatt bzw.
   2×2 Blätter je Abschnitt beim Papier und Maßstab aus Schritt 10), Verlegemodus (Antippen bzw. Anklicken = verlegt;
   Malen, Rechteck, Abschnittsfokus, „Nächster Stein“, Stein suchen, Bildschirm wach halten, soweit unterstützt),
   Abschnitt fertig markieren, Fortschritt in % (auch in „Meine Projekte“), Materialberechnung.
   **Koordinaten-CSV**: eine Zeile je Stein (Position, Lage und Maße in mm, Farbe, Form, Zuschnitt mit Vorlagennummer
   T# wie im PDF, verlegt), Spaltennamen in der Sprache der Oberfläche; im eigenen Worker gestreamt, mit Fortschritt
   und Abbrechen. Über 1.048.576 Zeilen warnt die App, dass Excel/LibreOffice die (vollständige) Datei nicht ganz öffnen.
   „Material & Einkauf“: „zu kaufen“ nur für Materialien mit erfasstem Bestand – fehlt der Bestand bei einem Material
   (oder gibt es Farben ohne Material), ist die Summe ausdrücklich eine Teilsumme („unvollständig“, auch in der CSV).
10. **PDF-Export** – A4/A3/A2/A1/A0/individuell, Hoch-/Querformat, Maßstab 1:1/2:1/3:1/4:1/an Seite anpassen.
   Inhalt wählbar mit gemessener Seitenzahl vorab („ca.“, nach dem Erzeugen die echte), Abschnittsauswahl (Raster,
   Zeile/Spalte, offene Abschnitte, Bereichsfeld wie `A1-B3`), Koordinaten „Kompakt (vollständig)“ oder „Je Stein“
   (mit Limit). Reicht der Arbeitsspeicher voraussichtlich nicht für eine Datei (Richtwert), wird **in Teilen**
   exportiert – siehe [PDF-Inhalt](#pdf-inhalt). Ist das Mosaik veraltet, fragt die App vor dem Export nach.

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
  immer die gemessenen Werte (z. B. „Inkreismaß 1,93 mm < 2 mm (schmalste Stelle 2,33 mm)“). Dieselbe Regel gilt für
  manuelle Formänderungen und k×k-Teilsteine (zu schmale Feinsteine werden nicht geteilt). Wird die Mindestbreite nach
  dem Berechnen erhöht, meldet „Material & Einkauf“ die nun zu schmalen Teile (Zahl aus der Statistik; im Steindetail
  markiert), statt sie still umzurechnen; für Freiformteile ist die Angabe bei nicht-konvexen Teilen ein Richtwert.
* **Formempfehlung vs. Schnittvorlage**: Formen, die sinnvoll wären, aber deaktiviert sind, werden nur als
  „Empfehlung – nicht berechnet“ markiert – und nur, wenn ihre Teile die Mindestbreite erfüllen. Nur aktivierte Formen
  erzeugen berechnete Schnittvorlagen.
* **Schnittlinien**: durchgehende Schnitte (rot, ritzen und brechen) und Einschnitte bis zur Innenecke nicht-konvexer
  Teile (orange gepunktet, nicht durchritzen) sind in App und PDF gleich gezeichnet und gleich nummeriert.
* **Zählung**: Es wird über Rasterzellen → Teilstücke iteriert; jeder Stein wird genau einmal gezählt.
  Die Tests prüfen `Steinfläche + Fugenfläche = Gesamtfläche`, eindeutige IDs und Summen je Farbe/Form/Größe/Abschnitt.
* **Materialbedarf – Rohsteine sind eine sichere Obergrenze (Richtwert)**: Je Farbe werden gleiche Schnittformen
  zusammengefasst (gedreht gilt als gleich, gespiegelt nicht) und je Gruppe aus der Ausbeute je Rohstein aufgerundet
  (ganzer Stein 1, Diagonaldreieck 2, Rechtecke so viele wie hineinpassen, sonstige Formen 1). Verschiedene
  Schnittformen und Reststücke teilen sich keinen Rohstein – die Zahl ist daher nie zu niedrig, kann aber über dem
  liegen, was geschicktes gemeinsames Zuschneiden bräuchte (ein Packen verschiedener Streifen in gemeinsame Rohsteine
  ist nicht umgesetzt). Reserve 5/10/15/20 % oder frei; Verschnitt = Rohsteinfläche dieser Zahl − Steinfläche.
  Rohsteinmaß = Maß des zugeordneten Materials, sonst Rastermaß (dann als angenommen gekennzeichnet).
  **Feinsteine**: Teilsteine einer k×k-Zelle, deren Maß genau dem Feinstein-Material ihrer Farbe entspricht, zählen als
  ganze, ungeschnittene Steine dieses Materials (eigene Zeile in Einkaufsliste, Materialliste und PDF, „+ N Fein“);
  ohne passendes Material werden sie aus dem Grundstein geschnitten und so gezählt. Ganze Steine und alle anderen
  Teile bleiben beim Grundstein-Material.
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
Dazu: Farblegende je Verlegeblatt („Steine auf diesem Blatt: N, davon K zugeschnitten“), Vorlagennummern T# im Stein
bzw. eine **Zuschnittliste je Blatt** für zugeschnittene Steine, die dafür zu klein sind (auf dem Blatt orange
umrandet), blaue Hilfslinien alle 10 Steine, Abschnittsübersicht für einblättrige Abschnitte und bei großen Projekten
eine Gesamtübersicht mit Kartenraster und Lagekarte je Abschnitt.

* **Codeplan**: Sind die Steine beim gewählten Maßstab zu klein für Farbnummern, werden nach jedem Verlegeblatt
  automatisch Codeplan-Seiten eingefügt – vergrößert, gleiche Zeilen und Spalten, ausdrücklich **nicht maßstäblich**
  und ohne Passkreuze (nur zum Nachschlagen der Farbnummern, nicht zum Auflegen).
* **Koordinaten**: Standard ist die kompakte, **vollständige** Liste (Spalten- und Zeilentabellen, Farbfolge je Zeile,
  Sonderteile einzeln – jeder Stein steht genau einmal); „Je Stein“ listet jeden Stein einzeln bis zum eingestellten
  Limit und benennt die Kürzung. Alle Koordinaten einzeln liefert die CSV in Schritt 9.
Beim Druck **„Tatsächliche Größe / 100 %“** wählen und die Kontrollstrecke nachmessen.

Abschnittsauswahl und **Export in Teilen**: Schnittvorlagen enthalten nur die Vorlagen der exportierten Abschnitte
(Nummern T1 … bleiben global, Stückzahlen gelten für die exportierten Abschnitte, das ganze Mosaik steht daneben).
Jedes Teil-PDF nennt „Teil k von n“ auf dem Deckblatt und in jeder Fußzeile; die Seitenzahl jedes Teils wird mit
seinen Abschnitten gemessen (`usePartFacts`, wie eine Einzeldatei derselben Abschnitte). Fertige Dateien gehören
zu allem, was im PDF steht (Optionen, Raster, Palette, Materialien, Einstellungen, Name, Foto, Sprache – `pdfFileSig`);
der Vermerk „Export läuft“ (`mp.pdfInFlight`) trägt Tab-Kennung und Lebenszeichen bzw. eine Web-Sperre, damit ein
zweiter Tab einen laufenden Export nie für einen Absturz hält. Dateinamen sind ASCII (`safeFileName`: ä → ae, ş → s …)
mit dem Wort der Oberflächensprache (`…_verlegeplan.pdf`, `…_laying-plan.pdf`, `…_doseme-plani.pdf`).

## Projektdatei (Export und Import)

*Meine Projekte → Exportieren* schreibt eine `*.mosaicplan.json` (Format-Version 2) mit Projekt und Einstellungen,
Originalfoto, berechnetem Mosaik (einschließlich der Fotofarbe je Stein für die Abweichungskarte), Verlegefortschritt
und **den verknüpften Materialien** (Palettenfarben, Feinstein-Materialien, Materialauswahl). Beim Import werden
Materialien über die ID oder über Hersteller, Produkt, Farbnummer und Größe vorhandenen zugeordnet, sonst neu angelegt;
bei mehreren gleich guten Kandidaten wird nicht geraten. Abweichende Daten ändern das Material des Zielgeräts nicht
(Rückmeldung je Material). Dateien der Version 1 (ohne Materialliste) werden weiter gelesen; fehlende Materialien
werden gemeldet. Das gespeicherte Vergleichsfoto ist **nicht** in der Datei – nach dem Import „Referenz neu erzeugen“.

## Materialien

Materialdatenbank mit Hersteller, Produkt, Farbnummer, HEX, Größe, Packung, Preis und Bestand; CSV-Import mit
Vorschau, Vorlage und CSV-Export. **Farbe aus Foto messen** (Kamera oder Foto): mittelt eine Fläche des Steins in
linearem sRGB, verwirft Spiegelungen und Fugenpixel, Weißabgleich mit weißem Papier (nur Farbstich) oder Graukarte 18 %
(Farbstich und Belichtung) und zeigt die Messstreuung. Das ist eine **Näherungsmessung – keine farbmetrische
Kamerakalibrierung**: Kamera-Automatik, Licht und Bildschirm beeinflussen das Ergebnis. Die Farbherkunft
(gemessen/Pipette/eingegeben) wird je Material gespeichert und angezeigt.

## Technik

React 19 + TypeScript, Vite, Canvas 2D (virtuelles Rendering nur sichtbarer Steine; Übersichtsbitmap beim
Herauszoomen), Web Worker für Berechnung/Statistik/PDF/CSV, IndexedDB, jsPDF (Schrift DejaVu Sans eingebettet,
damit Türkisch korrekt gedruckt wird), vite-plugin-pwa (Workbox) für Offline-Betrieb.

Rechenkern (`src/core`, ohne DOM, vollständig getestet):
`color.ts` (sRGB ⇄ CIELAB D65, CIE76, CIEDE2000), `kmeans.ts` (gewichtetes K-Means++ in Lab),
`imageOps.ts` (Gauß/Box-Filter, Sobel, Unschärfemaske, Tonwerte, Weißabgleich, Hintergrundvereinfachung),
`layout.ts` (Raster mit Fugen, Randzuschnitt, Abschnitte, IDs), `pieces.ts` (Polygone, Schnittanalyse),
`mosaic.ts` (Bildanalyse je Zelle, Formwahl, Palette, Zuordnung), `stats.ts`, `edits.ts`, `pdf.ts`, `csv.ts`, `render.ts`,
`journal.ts` (Verlauf Rückgängig/Wiederholen, nur im Arbeitsspeicher), `deviation.ts` und `batch.ts` (Abweichung,
Bereichsbearbeitung), `grout.ts` (Fugenfarben-Schätzung), `colorMeasure.ts` (Farbmessung), `faceDetect.ts`
(pico.js, `src/vendor/pico`).

## Tests

```bash
npm run typecheck
npm test                                   # Unit-/Integrationstests (Vitest), Stand: 1095 Tests in 55 Dateien
npm run build && npx vite preview --port 4173 &
npm run e2e                                # alle Browser-Tests (Playwright/Chromium), siehe unten
node e2e/run-e2e.cjs http://localhost:4173/ /tmp/e2e     # dasselbe mit Adresse und Ausgabeordner
```

`e2e/run-e2e.cjs` ist der eine Einstiegspunkt: zuerst der Grundablauf (17 Prüfungen), dann jedes Paket-Skript
`e2e/*.e2e.cjs` (Stand: 44 Skripte mit 1284 Prüfzeilen) mit Zusammenfassung; der Exit-Code ist nur 0, wenn alles
bestanden hat. Protokoll je Skript in `<ausgabeordner>/<skript>.log`, Screenshots in `<ausgabeordner>/<skript>/`,
Übersicht in `<ausgabeordner>/summary.txt`. Optionen: `E2E_JOBS=3` (gleichzeitige Skripte, 1 = nacheinander),
`E2E_FILTER=w6-,w5-undo` bzw. drittes Argument (nur passende Skripte; der Grundablauf dann nur mit `base`),
`E2E_BASE=0`, `E2E_PACKAGES=0`, `E2E_TIMEOUT_MIN=25`, `E2E_RETRY=1` (fehlgeschlagene Skripte einmal einzeln
wiederholen; als „FLAKY“ ausgewiesen). Zeitkritische Prüfungen (z. B. „Übernehmen < 300 ms“, „lange Aufgabe ≤ 50 ms“)
sind unter Parallel-Last empfindlicher als einzeln.

Geprüft werden u. a.: CIEDE2000 gegen die Referenzdaten von Sharma et al., Fugen in der Gesamtgröße,
exakte Randzuschnitte, eindeutige IDs, Steine innerhalb ihrer Zelle ohne Überlappung mit Mindestabstand = Fuge,
Stückzahlen je Farbe/Form/Größe/Abschnitt, Flächenbilanz, verlustfreies Speichern/Laden,
**PDF = Berechnung** (Anzahl der gezeichneten Steine je Farbe auf den Verlegeblättern),
Schnittvorlagen-Zuordnung, Großformat (200 × 100 cm mit 55.778 Positionen, 1000 × 500 cm mit 2 Mio. Positionen),
Übersetzungen (gleiche Schlüssel und Platzhalter in DE/EN/TR, auch je Erweiterungsdatei in `src/i18n/ext`, und kein
Schlüssel in zwei Erweiterungsdateien), sowie im Browser: Berechnung, Steindetail, Farb- und Formänderung (Dreieck mit
Schnittvorlage), Verlegemodus, Abschnitt fertig, Materialberechnung, PDF-Download, **Projekt und Fortschritt nach
Neustart erhalten**, Sprachen, Material anlegen, **Offline-Start**, Handy-Ansicht und die Funktionen der einzelnen
Arbeitspakete (u. a. Live-Vorschau, Freiform-Editor, Rückgängig, Abweichungskarte, Feinsteine, Farbe messen,
CSV-Streaming, PDF-Teile). Das APK-Verhalten wird im Browser nur mit einer nachgebauten Capacitor-Brücke geprüft.

Beispielprojekte (Startseite → „Beispielprojekte“): Menschenporträt, Landschaft, Tier (Katze), Stadtbild.
Die Beispielbilder sind synthetisch erzeugt (`scripts/svg/*.svg` → `scripts/render-svgs.cjs`), keine echten Fotos –
im gezeichneten Porträt finden die Gesichtsvorschläge deshalb kein Gesicht (dort ist der Gesichtsbereich vorgegeben).

## Status und Einschränkungen (ehrlich)

| Bereich | Status |
| --- | --- |
| Fotoimport, Zuschnitt, Drehen, Bildoptimierung | fertig |
| Bildanalyse CIELAB/ΔE, K-Means | fertig |
| Mosaikberechnung, Steingrößen 2–12 mm + individuell, Projektmaße, Fugen | fertig |
| Farblegende, Farbverwaltung, Materialdatenbank, Abgleich mit eigenen Materialien | fertig |
| Stein-für-Stein-Positionierung, Einzelstein-Ansicht und -Bearbeitung | fertig |
| Großformat-Aufteilung in Abschnitte, Fortschritt | fertig |
| Materialberechnung, PDF-Verlegeplan, CSV | fertig; Rohsteine je Farbe und Schnittform als sichere Obergrenze (Richtwert, siehe Materialbedarf) |
| Individuelle Schnittkonturen | fertig für Dreieck/Trapez/Rechteck/Kantenschnitt (automatisch) und Freiform je Rasterzelle (manuell) |
| Projektverwaltung, Export/Import mit Materialien, Offline | fertig (Vergleichsfoto nicht in der Projektdatei) |
| Live-Vorschau (Schritte 2–7) | fertig; selbsttätig bis 60.000 Positionen (langsame Geräte 30.000), darüber auf Knopfdruck |
| Rückgängig/Wiederholen | fertig für Farbe, Form und Freiform eines Steins, Bereichsbearbeitungen, Verlegefortschritt und Palettenänderungen in einem gemeinsamen Verlauf (Strg+Z / Strg+Umschalt+Z / Strg+Y; höchstens 200 Schritte bzw. 32 MB); **nur für die laufende Sitzung**: der Verlauf liegt im Arbeitsspeicher und wird nicht gespeichert – Neuladen, Verlassen des Projekts und Neuberechnen leeren ihn |
| Abweichungskarte und Bereichsbearbeitung | fertig (Foto ↔ Stein je Stein, ΔE in Worten; Farbe A → B, Heller/Dunkler, Form zurücksetzen mit Probelauf); ohne Fotoreferenz (Freiform, geänderte Form, ältere Raster) keine Abweichung statt einer Schätzung |
| Koordinaten | fertig: kompakte, vollständige Liste im PDF; CSV gestreamt im Worker (eine Zeile je Stein) |
| PDF in Teilen, Codeplan | fertig: Export in Teilen bei knappem Arbeitsspeicher (Grenze ist ein Richtwert), „Teil k von n“ im PDF; Codeplan-Seiten (nicht maßstäblich), wenn Farbnummern zu klein wären |
| **Gemischte Steingrößen** | **Stufe 1 fertig**: k×k-Teilung (2×2, 3×3) einer Rasterzelle, Feinstein-Größe sichtbar, Feinbereiche, Teilsteine in exakter Größe als ganze Steine eines eigenen Feinstein-Materials (eigene Einkaufszeile). **Nicht umgesetzt**: Zonen mit eigenem Raster (frei wählbare zweite Steingröße, z. B. 10/1 mm mit 5/1 mm) – Teilsteine, deren Maß kein ganzes Millimetermaß ist oder zu keinem Material passt, werden aus dem Grundstein geschnitten |
| **Gesichtsvorschläge** | offline mit pico.js (Vorschläge zum Übernehmen/Verwerfen; Augenpartie geschätzt, Konfidenz als Richtwert): nur frontale, fotografierte menschliche Gesichter – keine Profile, Tiere, sehr kleinen oder gezeichneten/gemalten Gesichter (z. B. das Beispielporträt); dann von Hand markieren. Augen, Mund usw. werden nicht einzeln erkannt |
| **Farbe messen** | fertig als **Näherungsmessung** aus einem Kamerafoto (linear sRGB, Papier/Graukarte als Referenz, Messstreuung) – **keine farbmetrische Kamerakalibrierung**; sonst HEX-Eingabe oder Pipette (ein Bildschirmpunkt, nicht in jedem Browser) |
| **Fugenfarben-Empfehlung** | fertig als **Modell-Schätzung** der Fernwirkung (allgemeine Farbtöne, keine Herstellerfarben); wird nur auf Wunsch übernommen |
| **Fugenkompensation** | **nicht umgesetzt**: die Farbzuordnung rechnet die Fugenfarbe nicht aus den Steinfarben heraus (Empfehlung und Fernwirkungs-Vorschau zeigen nur ihre Wirkung) |
| **Abschnittsgrenzen** | automatisch gleichmäßig nach Größe oder Anzahl (auf Rasterlinien, mit Vorgaben passend zum Papier); **verschiebbare Grenzen** (z. B. um ein Gesicht nicht zu teilen) sind **nicht umgesetzt** |
| **SVG-Export** | **nicht umgesetzt**: Pläne und Vorlagen gibt es als (vektorielles) PDF, die Vorschau als PNG |
| **Rauten** | **unvollständig**: werden erkannt/klassifiziert und können per Freiform gezeichnet werden; ein automatisches Rautenraster gibt es nicht |
| **Hintergrund vereinfachen** | heuristisch über Kantendichte (keine KI-Segmentierung) |
| **OpenCV** | **nicht verwendet**: die benötigten Verfahren (Filter, Sobel, Unschärfemaske, K-Means) sind in TypeScript implementiert und getestet; opencv.js (~8–10 MB WASM) wäre für Handy/Offline unverhältnismäßig |
| Freiform | Konturen bleiben innerhalb einer Rasterzelle; zellübergreifende Freiformsteine sind nicht möglich |
| Kantenschnitte | Winkel in 15°-Schritten, Versatz im 0,5-mm-Raster (bewusst, damit sich gleiche Schnittvorlagen wiederholen) |
| **Android: Speichern, Zurück-Taste, Systemleisten** | umgesetzt, aber **nicht auf einem Gerät geprüft** – nur im Quelltext, in Unit-Tests und im Browser mit nachgebauter Capacitor-Brücke; `npm run android:sync` läuft durch, der Gradle-Bau des APK und eine Installation wurden dabei nicht geprüft |
| Sehr große Projekte | Berechnung mit mehreren Millionen Positionen funktioniert (getestet bis 2 Mio.; Grenze 40 Mio. Rasterpositionen); Speicherbedarf und PDF-Umfang steigen entsprechend – große PDFs abschnittsweise oder in Teilen exportieren, vollständige Koordinaten per CSV |
| Browser | geprüft mit Chromium (Playwright); Firefox und Safari nicht automatisiert getestet |
