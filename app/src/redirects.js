// Retired marketing pages → their section on the one-page site, so old
// links, LINE messages and search results keep working. Mounted before
// express.static (the HTML files are gone).
export const MOVED = {
  '/features.html': '/#family',
  '/how-it-works.html': '/#setup',
  '/family.html': '/#family',
  '/stats.html': '/',
};

export function mountRedirects(app, moved = MOVED) {
  for (const [from, to] of Object.entries(moved)) app.get(from, (req, res) => res.redirect(301, to));
}
