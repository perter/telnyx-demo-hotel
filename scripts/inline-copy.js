// Dev helper: writes the English copy into the HTML as the default text of
// every [data-i18n] element (what shows before the scripts run):
//   node scripts/inline-copy.js
import { readFileSync, writeFileSync } from "node:fs";

const dict = {};
globalThis.I18N = { extend: (more) => Object.assign(dict, more.en) };
for (const f of ["en", "flow-en"]) await import(new URL(`../public/i18n/${f}.js`, import.meta.url));

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
for (const page of ["index.html", "flow.html"]) {
  const file = new URL(`../public/${page}`, import.meta.url);
  let html = readFileSync(file, "utf8");
  // Element text: <tag … data-i18n="key" …>text</tag> (text without child tags).
  html = html.replace(/(<[a-z0-9]+\b[^>]*\bdata-i18n="([^"]+)"[^>]*>)([^<]*)(?=<)/g, (all, open, key) =>
    key in dict ? open + esc(dict[key]) : all);
  // Attributes named in data-i18n-attr="attr:key,attr:key".
  html = html.replace(/<[a-z0-9]+\b[^>]*\bdata-i18n-attr="([^"]+)"[^>]*>/g, (tag, pairs) => {
    for (const pair of pairs.split(",")) {
      const [attr, key] = pair.split(":").map((x) => x.trim());
      if (key in dict) tag = tag.replace(new RegExp(`(\\s${attr}=")[^"]*(")`), `$1${esc(dict[key]).replace(/"/g, "&quot;")}$2`);
    }
    return tag;
  });
  html = html.replace(/<title>[^<]*<\/title>/, `<title>${esc(dict[page === "flow.html" ? "flow.pageTitle" : "page.title"])}</title>`);
  writeFileSync(file, html);
  console.log(`${page}: default copy set to English`);
}
