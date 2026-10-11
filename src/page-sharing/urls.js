'use strict';

// Das Theme gehört zum jeweiligen Link, nicht zur gespeicherten Freigabe oder
// zu einem angemeldeten Benutzer. Andere Werte fallen auf die helle Ansicht.
function shareTheme(value) { return value === 'dunkel' ? 'dunkel' : 'hell'; }
function withTheme(path, theme) {
  const url = new URL(path, 'http://homeess.invalid');
  url.searchParams.set('theme', shareTheme(theme));
  return `${url.pathname}${url.search}${url.hash}`;
}
module.exports = { shareTheme, withTheme };
