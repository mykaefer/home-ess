'use strict';

// Anordnung der Knoten auf der Netzwerkkarte.
//
// Die Funktion `layoutNetwork` ist bewusst frei von jedem Browser- und
// Modulbezug: Sie wird per `toString()` in das Seitenskript eingebettet und
// läuft dort unverändert. Damit gibt es genau eine Fassung des Algorithmus —
// die getestete.
//
// Verfahren: kräftebasiert. Alle Knoten stoßen sich ab, jede gemessene
// Funkstrecke wirkt als Feder, und eine schwache Rückstellkraft hält das Bild
// zusammen. Die Ruhelänge einer Feder hängt an der Verbindungsqualität — eine
// gute Strecke zieht zwei Knoten enger zusammen als eine schwache. Die Karte
// bildet die Qualität dadurch nicht nur farblich, sondern auch räumlich ab.

/* eslint-disable no-param-reassign */
function layoutNetwork(nodes, edges, options) {
  var settings = options || {};
  var width = settings.width || 1000;
  var height = settings.height || 640;
  var iterations = settings.iterations || 420;
  var margin = settings.margin || 46;
  var i;
  var j;
  var step;
  var a;
  var b;
  var dx;
  var dy;
  var distance;
  var force;

  var byAddress = {};
  for (i = 0; i < nodes.length; i++) byAddress[nodes[i].address] = nodes[i];

  // Nur Kanten zwischen tatsächlich dargestellten Knoten wirken.
  var links = [];
  for (i = 0; i < edges.length; i++) {
    a = byAddress[edges[i].source];
    b = byAddress[edges[i].target];
    if (a && b && a !== b) {
      links.push({ a: a, b: b, ratio: edges[i].quality && typeof edges[i].quality.ratio === 'number'
        ? edges[i].quality.ratio : 0.4 });
    }
  }

  // Startlage auf einem Ring. Der Coordinator sitzt in der Mitte und bleibt
  // dort — er ist der feste Bezugspunkt des Netzes.
  var linked = {};
  for (i = 0; i < links.length; i++) {
    linked[links[i].a.address] = true;
    linked[links[i].b.address] = true;
  }
  var loose = [];
  for (i = 0; i < nodes.length; i++) {
    a = nodes[i];
    if (a.isCoordinator) {
      a.x = width / 2;
      a.y = height / 2;
      a.fixed = true;
    } else if (!linked[a.address]) {
      // Ein Knoten ohne erkannte Funkstrecke bekommt einen eigenen Streifen am
      // unteren Rand. Frei mitschwimmend würde er Nähe vortäuschen, die nicht
      // gemessen wurde.
      loose.push(a);
    } else {
      var angle = (i / (nodes.length || 1)) * Math.PI * 2;
      var radius = 140 + (i % 5) * 45;
      a.x = width / 2 + Math.cos(angle) * radius;
      a.y = height / 2 + Math.sin(angle) * radius;
      a.fixed = false;
    }
    a.vx = 0;
    a.vy = 0;
  }
  var perRow = Math.max(1, Math.floor((width - 2 * margin) / 96));
  for (i = 0; i < loose.length; i++) {
    a = loose[i];
    a.x = margin + 24 + (i % perRow) * ((width - 2 * margin - 48) / Math.max(1, perRow - 1));
    a.y = height - margin - Math.floor(i / perRow) * 74;
    a.fixed = true;
    a.isolated = true;
  }

  for (step = 0; step < iterations; step++) {
    var cooling = 1 - (step / iterations) * 0.75;

    for (i = 0; i < nodes.length; i++) {
      a = nodes[i];
      for (j = i + 1; j < nodes.length; j++) {
        b = nodes[j];
        dx = b.x - a.x;
        dy = b.y - a.y;
        distance = Math.sqrt(dx * dx + dy * dy);
        if (distance < 0.01) {
          // Exakt deckungsgleiche Knoten hätten keine Richtung; ein winziger
          // Versatz bringt die Abstoßung in Gang.
          dx = (i % 2 === 0 ? 1 : -1) * 0.5;
          dy = 0.5;
          distance = 0.71;
        }
        if (distance > 420) continue;
        force = 9000 / (distance * distance);
        dx = (dx / distance) * force;
        dy = (dy / distance) * force;
        a.vx -= dx;
        a.vy -= dy;
        b.vx += dx;
        b.vy += dy;
      }
    }

    for (i = 0; i < links.length; i++) {
      a = links[i].a;
      b = links[i].b;
      dx = b.x - a.x;
      dy = b.y - a.y;
      distance = Math.sqrt(dx * dx + dy * dy) || 0.01;
      force = (distance - (110 + (1 - links[i].ratio) * 150)) * 0.012;
      dx = (dx / distance) * force;
      dy = (dy / distance) * force;
      a.vx += dx;
      a.vy += dy;
      b.vx -= dx;
      b.vy -= dy;
    }

    for (i = 0; i < nodes.length; i++) {
      a = nodes[i];
      a.vx += (width / 2 - a.x) * 0.0016;
      a.vy += (height / 2 - a.y) * 0.0016;
      if (a.fixed || a.pinned) {
        a.vx = 0;
        a.vy = 0;
        continue;
      }
      a.x += Math.max(-25, Math.min(25, a.vx * cooling));
      a.y += Math.max(-25, Math.min(25, a.vy * cooling));
      a.vx *= 0.55;
      a.vy *= 0.55;
      a.x = Math.max(margin, Math.min(width - margin, a.x));
      a.y = Math.max(margin, Math.min(height - margin, a.y));
    }
  }
  return nodes;
}
/* eslint-enable no-param-reassign */

// Quelltext der Funktion für die Einbettung ins Seitenskript. `toString()` ist
// hier zulässig, weil die Funktion keine Werte aus ihrer Umgebung verwendet.
function layoutSource() {
  return layoutNetwork.toString();
}

module.exports = { layoutNetwork, layoutSource };
