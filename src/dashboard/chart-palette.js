'use strict';

// Farbreihenfolge der Diagrammlinien. Eigenes Modul, weil sowohl die
// SVG-Erzeugung als auch die Konfiguration (Vorbelegung neuer Linien) sie
// braucht — und ein gegenseitiger require zwischen beiden vermieden wird.
//
// Geprüft auf Farbfehlsichtigkeit und Kontrast auf hellem Grund: benachbarte
// Paare ΔE ≥ 8 bei Deuteranopie, alle Farben ≥ 3:1 gegen die Kachelfläche.
// Reihenfolge ist fest — die erste Linie bekommt immer denselben Farbton.
const SERIES_COLORS = ['#2f6fb5', '#a8791a', '#8e4ec6', '#1f9d6b'];

module.exports = { SERIES_COLORS };
