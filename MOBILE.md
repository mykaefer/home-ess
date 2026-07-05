# MOBILE — Smartphone-Ansicht von homeESS

> **Zweck:** Grundkonstrukt und Arbeitsstand der mobilen Ansicht. Jede Seite
> und jeder Dialog erhält eine vollwertige Smartphone-Darstellung mit der
> gleichen Funktionalität wie am Desktop — kein bloßes Zusammenquetschen der
> Desktop-Kacheln. Beim Abschluss einer Seite die Checkliste unten pflegen.

## Konzept

- **Ein Breakpoint:** `@media (max-width: 768px)` = Smartphone-Ansicht.
  Alles darüber bleibt die unveränderte Desktop-Ansicht.
- **Gleiches DOM, zwei Darstellungen.** Die Seiten bleiben serverseitig
  gerendert (Leitprinzip 1); die mobile Darstellung entsteht per CSS im
  **Mobile-Layer am Ende von `public/styles.css`**. Der Layer steht bewusst
  hinter allen älteren `max-width`-Regeln (640/720/760/900px) und gewinnt
  damit die Kaskade — ältere Regeln müssen nicht angefasst werden.
- **Mobile-eigene Bausteine** (Tab-Bar, Menü-Sheet) werden in `layout.js`
  immer mitgerendert und sind am Desktop per CSS unsichtbar.
- Braucht eine Seite abweichendes Markup, gibt es die Utilities
  `.only-mobile` / `.only-desktop` (Anzeige nur in der jeweiligen Ansicht).

## Shell (layout.js + Mobile-Layer)

- **Header:** kompakt, `position: sticky` statt `fixed` — er darf dadurch
  bei Platzmangel gefahrlos in eine zweite Zeile umbrechen (**kein
  horizontales Scrollen**). Zeit-/Datum-Pills sind ausgeblendet (zeigt das
  Smartphone selbst), das „Aussen"-Label entfällt (der °C-Wert spricht für
  sich), die Batterie zeigt nur das Icon mit Füllstand (ohne Prozentzahl);
  Temperatur, Batterie, Betriebslevel und Himmelssymbol bleiben sichtbar.
- **Sidebar aus**, stattdessen:
  - **Tab-Bar unten** (fixiert, `MOBILE_TABS` in `layout.js`): Dashboard,
    Strom, Batterie, Prognose + **Menü**.
  - **Menü-Sheet** (vollflächig, `renderMobileNav`): alle Hauptseiten inkl.
    aktivierter Module und Unterseiten, Footer-Seiten (Module,
    Einstellungen), Abmelden, Copyright/Version.
- `main-content` reserviert unten Platz für die Tab-Bar
  (`env(safe-area-inset-bottom)` für iPhone-Home-Indicator; Viewport-Meta
  mit `viewport-fit=cover`).

## Framework-Regeln (gelten automatisch auf allen Seiten)

| Baustein | Mobil |
| --- | --- |
| `.kpi-row` | festes 2er-Raster (`grid`), kompaktere Kacheln |
| `.value-dialog` (alle Dialoge) | **Bottom-Sheet**: volle Breite, unten angedockt, abgerundete obere Ecken, innen scrollbar |
| `.dialog-grid--*` | einspaltig |
| `.content-grid--split` | einspaltig |
| Inputs/Selects/Textareas | `font-size: 16px` (verhindert iOS-Auto-Zoom), `min-height: 44px` |
| Buttons (`.button-row`, Formulare, Dialoge), `.icon-button` | Touch-Ziel ≥ 44px |

## Arbeitsweise je Seite

1. Seite am Smartphone-Viewport (≈ 390px) durchgehen: Was bricht, was ist
   unbedienbar, welche Information geht verloren?
2. Seiten-Abschnitt im Mobile-Layer von `styles.css` ergänzen
   (Kommentar-Überschrift `── <Seite> ──`). Ziel ist eine **eigene mobile
   Informationsarchitektur** (Zeilenlisten statt schmaler Spalten,
   gestapelte Karten, volle Breite), nicht nur Umbruch.
3. Nur wenn CSS nicht reicht: mobiles Zusatz-Markup über
   `.only-mobile`/`.only-desktop` in der View ergänzen.
4. Dialoge der Seite als Bottom-Sheet prüfen (Scrollen, Tastatur, Buttons
   erreichbar).
5. Checkliste hier aktualisieren, CHANGELOG-Eintrag.

## Bekannte offene Punkte (Framework)

- **Drag & Drop** (Dashboard, Messen + Schalten) ist natives HTML5-DnD und
  funktioniert nicht per Touch — mobile Alternative nötig (z. B.
  Verschieben-Aktion im Bearbeiten-Dialog). Siehe Roadmap-Punkt in
  PROJECT_CONTEXT.md.
- **State-Picker-Popover** dockt am Eingabefeld an; am Smartphone ggf.
  besser als Bottom-Sheet.

## Checkliste / Arbeitsstand

| Seite | Status | Anmerkungen |
| --- | --- | --- |
| Shell (Header, Navigation, Menü) | ✅ umgesetzt | Sticky-Header (darf zweizeilig umbrechen, kein horizontales Scrollen), Tab-Bar + Menü-Sheet |
| Prognose | ✅ umgesetzt | Referenz-Umsetzung |
| Dashboard | ✅ umgesetzt | 2er-Widget-Raster, Info-Widgets volle Breite, Aktionen immer sichtbar; **DnD-Ersatz offen** |
| Stromverbrauch | ✅ umgesetzt | Energie-Tabelle als Karten mit ::before-Labels (Heute/Woche/Jahr/Vorjahr) |
| Photovoltaik | ✅ umgesetzt | Anlagenkarten gestapelt, Prognosestreifen 2er-Raster |
| Batterie | ✅ umgesetzt | komplett durch Framework abgedeckt (KPI-Raster, field-grid kollabiert) |
| Messen + Schalten | ✅ umgesetzt | Gerätezeile zweizeilig (Name/Leistung/Schalter + Betriebsart/Zähler/Aktionen); **DnD-Ersatz offen** |
| Schaltgruppen (Unterseite) | ✅ Basis | Spalten stapeln sich (Gruppen, darunter nicht zugeordnete Geräte), Seite scrollt selbst; **DnD-Ersatz offen** |
| Adapter / Instanzen | ✅ umgesetzt | Instanz-Zeilen 2-spaltig, Adresse volle Breite |
| Adapter-States (State-Editor) | ✅ umgesetzt | Register-Tabelle scrollt im eigenen Container (bewusst Tabelle) |
| States | ✅ umgesetzt | Baum + umbruchfähige Wert-Zeilen (Querschnitt) |
| Output | ✅ umgesetzt | Zeilen stapeln, Aktionen mit Touch-Größe |
| Module | ✅ umgesetzt | Karten gestapelt, vollbreiter Aktivieren-Button |
| Einstellungen | ✅ umgesetzt | durch Framework abgedeckt |
| Pool (Modul) | ✅ umgesetzt | Modus-Buttons als vollbreite Segmente |
| Wallbox (Modul) | ✅ umgesetzt | teilt plant-Bausteine mit Photovoltaik |
| Grid-Control (Modul) | ✅ umgesetzt | Protokollzeilen umbruchfähig |
| Login | ✅ umgesetzt | Karte passt sich der Bildschirmbreite an |
| Wertekatalog / State-Picker (Querschnitt) | ✅ Basis | größere Touch-Zeilen, Labels umbruchfähig; State-Picker ggf. später als Bottom-Sheet |
