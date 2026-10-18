// Page copy engine. The copy itself lives in i18n/<lang>.js (booking page) and
// i18n/flow-<lang>.js ("how it works" page), one file per language; each calls
// I18N.extend(). The whole site follows the front desk's language: the starting
// language chosen in the widget, and any switch the guest makes during a call.
// English is the fallback for a missing key. Exposed as window.I18N.
(function (root) {
  const STRINGS = {};
  const LOCALES = { en: "en-GB", fr: "fr-FR", de: "de-DE", it: "it-IT", es: "es-ES", nl: "nl-NL" };
  const FALLBACK = "en";
  let lang = FALLBACK;

  function t(key, vars) {
    const dict = STRINGS[lang] || {};
    const one = vars && Number(vars.n) === 1 && dict[`${key}_one`];
    let s = (one ? dict[`${key}_one`] : dict[key]) ?? STRINGS[FALLBACK]?.[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
    return s;
  }

  const api = {
    get lang() { return lang; },
    // Every language file adds its copy here.
    extend(more) { for (const [code, dict] of Object.entries(more)) Object.assign(STRINGS[code] ||= {}, dict); },
    has: (code) => !!STRINGS[code],
    set(next) { if (STRINGS[next]) lang = next; },
    t,
    locale: () => LOCALES[lang],
    date: (d) => d.toLocaleDateString(LOCALES[lang], { weekday: "long", day: "numeric", month: "long", year: "numeric" }),
    eur: (n) => new Intl.NumberFormat(LOCALES[lang], { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n),
    // Applies every [data-i18n] / [data-i18n-attr] on the page.
    apply(scope = document) {
      scope.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
      scope.querySelectorAll("[data-i18n-attr]").forEach((el) => {
        for (const pair of el.dataset.i18nAttr.split(",")) {
          const [attr, key] = pair.split(":");
          el.setAttribute(attr.trim(), t(key.trim()));
        }
      });
      scope.querySelectorAll("[data-i18n-lang]").forEach((el) => (el.textContent = lang.toUpperCase()));
      document.documentElement.lang = lang;
      document.title = t(document.documentElement.dataset.titleKey || "page.title");
    },
  };

  root.I18N = api;
})(typeof window !== "undefined" ? window : globalThis);
