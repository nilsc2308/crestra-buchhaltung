# crestra Buchhaltung

App für die Buchhaltung von crestra (Einzelunternehmen, Kleinunternehmer nach § 19 UStG).
Läuft wie das Kundenboard als App auf Handy und Mac: **https://nilsc2308.github.io/crestra-buchhaltung/**
(am iPhone in Safari öffnen → Teilen → „Zum Home-Bildschirm“).

Anmeldung: dieselbe wie im Kundenboard. Wer dort angemeldet ist, ist es hier automatisch auch.

## Was die App kann

| Bereich | Inhalt |
|---|---|
| Überblick | Kontostand, Einnahmen/Ausgaben/Gewinn des Jahres, Kleinunternehmer-Grenzen (25.000 € / 100.000 €), offene Rechnungen, Aufgaben |
| Umsätze | Bankumsätze (automatisch oder per CSV), Kategorien mit Vorschlägen und Regeln, Belege anhängen, Bar-/Privatausgaben eintragen |
| Rechnungen | Rechnungen mit § 19-Hinweis, fortlaufende Nummern RE-JJJJ-NNNN, Festschreiben (danach nicht mehr änderbar, GoBD), Storno, PDF über „Drucken“; Monatsrechnungen für alle Board-Kunden mit Status „gewonnen“ und Monatspreis |
| Belege | Quittungen fotografieren oder PDFs hochladen, Umsätzen zuordnen (privater Speicher, nur für dich lesbar) |
| Auswertung | Einnahmen-Überschuss-Rechnung je Jahr (Bewirtung zu 70 %), CSV für Steuerberater, Druck |
| Einstellungen | Firmendaten, Bankverbindung, Regeln, Sicherung (JSON) |

Zahlungseingänge, deren Verwendungszweck die Rechnungsnummer enthält und deren Betrag passt, werden automatisch der Rechnung zugeordnet und die Rechnung als bezahlt markiert.

## Bank automatisch verbinden (einmalig, ca. 10 Minuten)

Die App liest Umsätze und Kontostand über **Enable Banking**, einen zugelassenen Kontoinformationsdienst
(EU-Schnittstelle PSD2, nur Lesezugriff). Für das eigene Konto ist das kostenlos. Unterstützt werden u. a.
Qonto, Kontist, N26, Holvi, Finom, Sparkasse, Volksbank und die großen Banken.

1. Auf **https://enablebanking.com** ein Konto anlegen und ins Control Panel gehen.
2. **Applications → Register new application**:
   - Environment: **Production**
   - Name: `crestra Buchhaltung`
   - Allowed redirect URLs: `https://nilsc2308.github.io/crestra-buchhaltung/bank.html`
   - „Generate private RSA key in the browser“ wählen → **Register**. Der Browser lädt eine `.pem`-Datei herunter.
3. Die Datei nach `~/.config/crestra/enablebanking.pem` verschieben (Ordner gibt es schon; nicht in einen Projektordner legen).
4. Bei der neuen App **„Activate by linking accounts“** wählen und das eigene Geschäftskonto verknüpfen
   (eingeschränkter Modus: die App darf dann nur deine eigenen Konten lesen, ohne Vertrag mit Enable Banking).
5. Claude die **Application ID** nennen. Claude hinterlegt sie mit der `.pem`-Datei als geheime Werte in Supabase:
   ```
   npx supabase@latest secrets set --project-ref mvcwhvntbvnldqimjiki EB_APP_ID=<Application ID> EB_PRIVATE_KEY="$(cat ~/.config/crestra/enablebanking.pem)"
   ```
6. In der App **Einstellungen → Konto verbinden** → Bank wählen → bei der Bank anmelden und freigeben.

Die Bank verlangt alle 90 Tage eine neue Freigabe. Die App erinnert 10 Tage vorher („Neu verbinden“).
Beim Öffnen ruft sie neue Umsätze automatisch ab (höchstens alle 6 Stunden), sonst per „↻ Bank abrufen“.

**Bis dahin:** Im Online-Banking die Umsätze als CSV exportieren und unter Umsätze → „CSV importieren“
hochladen. Die Spalten werden erkannt, doppelte Umsätze übersprungen. Das geht auch später noch, die
automatisch abgerufenen Umsätze werden nicht doppelt gezählt.

## Technik

- Statische Seiten ohne Build: `index.html`, `styles.css`, `app.js`, `db.js` (Anmeldung + Datenbank, gleich wie im Board), `config.js`, `bank.html` (Rückkehr von der Bank), `sw.js` (Offline-Hülle).
- Daten: Supabase-Projekt „claude“ (`mvcwhvntbvnldqimjiki`), Tabelle `docs`, Sammlungen `buchungen`, `rechnungen`, `belege`, `buchhaltung/einstellungen`, `buchhaltung/bank`; liest `sites` aus dem Board.
- Belege: privater Speicher-Bucket `belege` (`supabase/storage.sql`), Pfad `<Nutzer-ID>/<Beleg-ID>.<Endung>`, max. 15 MB.
- Bank: Edge Function `supabase/functions/bank` (Enable Banking). Bereitstellen mit
  `npx supabase@latest functions deploy bank --project-ref mvcwhvntbvnldqimjiki --use-api`.
- Geldbeträge in Cent, Daten als JJJJ-MM-TT. Festgeschriebene Rechnungen speichern die Absenderdaten mit, damit spätere Änderungen alte Rechnungen nicht verändern.

## Grenzen (ehrlich)

- Hilfe zur Buchhaltung, keine Steuerberatung. Die EÜR-Auswertung ersetzt nicht die Prüfung durch einen Steuerberater.
- GoBD: Rechnungen sind in der App festgeschrieben. Eine zertifizierte, revisionssichere Archivierung ist das nicht. Deshalb einmal im Quartal die Sicherung herunterladen.
- E-Rechnung: Kleinunternehmer dürfen weiter PDF-Rechnungen schreiben. Empfangen müssen alle Unternehmen E-Rechnungen können; XRechnung-Dateien lassen sich als Beleg hochladen, werden aber nicht ausgelesen.
