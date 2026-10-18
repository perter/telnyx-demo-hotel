// Concierge widget settings, managed from the admin panel (/assistant.html):
// which languages a guest can start the call in, the shortlist of Telnyx Ultra
// voices offered per language (with a default) and the greeting per language.
// Stored as one JSON document in the settings table (key "concierge"), cached
// for a few seconds so changes made on another instance show up.
const KEY = "concierge";
const TTL = 5000;

// Languages the widget can offer. `name` goes into the prompt, `label` is shown
// to guests, `match` picks the Telnyx Ultra voices of that language. The page
// copy (public/i18n/) exists in the same six languages.
export const LANGUAGES = {
  en: { name: "English", label: "English", match: /^en/i,
    greeting: "{salutation} and welcome to TelnyxHotel! I'm {name} from the front desk. How may I help you?" },
  fr: { name: "French", label: "Français", match: /^fr/i,
    greeting: "{salutation} et bienvenue chez TelnyxHotel ! Je suis {name}, de la réception. Comment puis-je vous aider ?" },
  de: { name: "German", label: "Deutsch", match: /^de/i,
    greeting: "{salutation} und willkommen bei TelnyxHotel! Ich bin {name} von der Rezeption. Wie kann ich Ihnen helfen?" },
  it: { name: "Italian", label: "Italiano", match: /^it/i,
    greeting: "{salutation} e benvenuti da TelnyxHotel! Sono {name} della reception. Come posso aiutarla?" },
  es: { name: "Spanish", label: "Español", match: /^es/i,
    greeting: "¡{salutation} y bienvenidos a TelnyxHotel! Soy {name}, de la recepción. ¿En qué puedo ayudarle?" },
  nl: { name: "Dutch", label: "Nederlands", match: /^nl/i,
    greeting: "{salutation} en welkom bij TelnyxHotel! U spreekt met {name} van de receptie. Waarmee kan ik u helpen?" },
};
const ALL = Object.keys(LANGUAGES);

// Voices offered when an admin hasn't picked any for a language yet: the ones
// whose description sounds like a host come first.
const HOSPITABLE = /host|concierge|hospitab|friendly|guide|support/i;
const MAX_VOICES = 12;

let db;
let cache = null;
let loadedAt = 0;

export function initConcierge(database) {
  db = database;
}

function defaultVoices(lang, catalog) {
  const list = catalog.filter((v) => LANGUAGES[lang].match.test(v.language));
  const hosts = list.filter((v) => HOSPITABLE.test(v.name));
  return [...hosts, ...list].filter((v, i, all) => all.indexOf(v) === i).slice(0, 5).map((v) => v.id);
}

async function stored() {
  if (cache && Date.now() - loadedAt < TTL) return cache;
  const { results } = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(KEY).all();
  cache = results[0] ? JSON.parse(results[0].value) : {};
  loadedAt = Date.now();
  return cache;
}

// The effective configuration: what's stored, completed with defaults, and
// cleaned of voices that no longer exist in the Telnyx catalog.
export async function getConcierge(catalog) {
  const s = await stored();
  const languages = (s.languages || ALL).filter((l) => LANGUAGES[l]);
  const config = {
    languages: languages.length ? languages : ["en"],
    defaultLanguage: null,
    voices: {},
    defaultVoice: {},
    greetings: {},
  };
  config.defaultLanguage = config.languages.includes(s.defaultLanguage) ? s.defaultLanguage : config.languages[0];
  for (const lang of Object.keys(LANGUAGES)) {
    const valid = (s.voices?.[lang] || []).filter((id) => catalog.some((v) => v.id === id && LANGUAGES[lang].match.test(v.language)));
    config.voices[lang] = valid.length ? valid : defaultVoices(lang, catalog);
    config.defaultVoice[lang] = config.voices[lang].includes(s.defaultVoice?.[lang]) ? s.defaultVoice[lang] : config.voices[lang][0] ?? null;
    config.greetings[lang] = s.greetings?.[lang] || LANGUAGES[lang].greeting;
  }
  return config;
}

// What the booking page needs: enabled languages and their voices only.
export async function publicConcierge(catalog) {
  const c = await getConcierge(catalog);
  return {
    defaultLanguage: c.defaultLanguage,
    languages: c.languages.map((code) => ({
      code,
      name: LANGUAGES[code].name,
      label: LANGUAGES[code].label,
      greeting: c.greetings[code],
      defaultVoice: c.defaultVoice[code],
      voices: c.voices[code].map((id) => catalog.find((v) => v.id === id)).filter(Boolean)
        .map(({ id, name, label, gender }) => ({ id, name, label, gender })),
    })),
  };
}

const bad = (message) => Object.assign(new Error(message), { status: 400 });

export async function saveConcierge(body, catalog) {
  const languages = [...new Set(Array.isArray(body?.languages) ? body.languages : [])].filter((l) => LANGUAGES[l]);
  if (!languages.length) throw bad("Enable at least one language");
  if (!languages.includes(body.defaultLanguage)) throw bad("The default language must be one of the enabled languages");
  const out = { languages, defaultLanguage: body.defaultLanguage, voices: {}, defaultVoice: {}, greetings: {} };
  for (const lang of Object.keys(LANGUAGES)) {
    const ids = [...new Set(Array.isArray(body.voices?.[lang]) ? body.voices[lang] : [])];
    const unknown = ids.filter((id) => !catalog.some((v) => v.id === id && LANGUAGES[lang].match.test(v.language)));
    if (unknown.length) throw bad(`Not a ${LANGUAGES[lang].name} Telnyx Ultra voice: ${unknown[0]}`);
    if (ids.length > MAX_VOICES) throw bad(`At most ${MAX_VOICES} voices per language`);
    if (languages.includes(lang) && !ids.length) throw bad(`Pick at least one voice for ${LANGUAGES[lang].name}`);
    if (ids.length) {
      out.voices[lang] = ids;
      out.defaultVoice[lang] = ids.includes(body.defaultVoice?.[lang]) ? body.defaultVoice[lang] : ids[0];
    }
    const greeting = String(body.greetings?.[lang] ?? "").trim();
    if (greeting.length > 400) throw bad(`The ${LANGUAGES[lang].name} greeting is too long (max 400 characters)`);
    if (greeting && greeting !== LANGUAGES[lang].greeting) out.greetings[lang] = greeting;
  }
  await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(KEY, JSON.stringify(out)).run();
  cache = out;
  loadedAt = Date.now();
  return getConcierge(catalog);
}
