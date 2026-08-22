'use strict';

// Farbreihenfolge der Diagrammlinien. Eigenes Modul, weil sowohl die
// SVG-Erzeugung als auch die Konfiguration (Vorbelegung neuer Linien) sie
// braucht — und ein gegenseitiger require zwischen beiden vermieden wird.
//
// Geprüft auf Farbfehlsichtigkeit und Kontrast auf hellem Grund: benachbarte
// Paare ΔE ≥ 8 bei Deuteranopie, alle Farben ≥ 3:1 gegen die Kachelfläche.
// Reihenfolge ist fest — die erste Linie bekommt immer denselben Farbton.
const SERIES_COLORS = ['#2f6fb5', '#a8791a', '#8e4ec6', '#1f9d6b'];

// Flächenfüllung je Linie: der Bereich zwischen Linie und Nulllinie wird in der
// Linienfarbe hinterlegt. Ganz deckend wäre die Fläche nicht mehr von der Linie
// zu unterscheiden und verdeckte darunterliegende Linien — deshalb eine
// einstellbare Transparenz mit gedeckter Vorgabe und einer Obergrenze unterhalb
// von „vollflächig".
const DEFAULT_AREA_OPACITY = 0.2;
const MIN_AREA_OPACITY = 0.05;
const MAX_AREA_OPACITY = 0.8;

module.exports = { SERIES_COLORS, DEFAULT_AREA_OPACITY, MIN_AREA_OPACITY, MAX_AREA_OPACITY };
