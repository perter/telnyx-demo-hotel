// Tiny language detector for live transcripts: scores common function words
// and hotel vocabulary of English, French, German, Italian, Spanish and Dutch,
// plus a few tell-tale letters. Returns a language code, or null when unsure
// (short or ambiguous utterances keep the current language). Words shared by
// several languages are listed in each, so they cancel out.
// Exposed as window.LangDetect.
(function (root) {
  const WORDS = {
    en: `the a an and is are was were be been to for with of on at from by this that these those in it
      you your we our us my me he she they them it's i'm i'd i'll we'd we'll would could should can will
      like want please thank thanks hello hi hey yes yeah okay sure great good morning evening goodbye bye
      room rooms night nights book booking reservation people adults kids children breakfast view day days
      october september august july june may april tomorrow today arrive arrival departure check how what when
      where why which much many there here have has do does did not no need looking stay two three four
      speak speaking talk english language name`,
    fr: `le la les un une des du de au aux et est sont je j tu il elle nous vous ils elles on ce cette ces
      mon ma mes notre nos votre vos pour avec dans sur par pas ne n que qu qui quoi où quand comment combien
      oui non merci bonjour bonsoir salut au revoir s'il plaît voudrais aimerais souhaite peux pouvez puis
      ai avons avez ont suis sommes êtes chambre chambres nuit nuits réserver réservation personnes adultes
      enfants petit déjeuner vue jour jours octobre septembre août juillet juin mai avril demain aujourd'hui
      arrivée départ d'accord parfait bien très c'est parler parlez français langue deux trois quatre appelle nom`,
    de: `der die das den dem des ein eine einen einem einer und ist sind war ich du er sie es wir ihr ihnen
      mein meine unser unsere für mit von zu zum zur im in am an auf aus bei nach nicht kein keine dass was wer
      wie wo wann warum welche ja nein danke bitte hallo guten tag morgen abend tschüss auf wiedersehen möchte
      möchten hätte gerne kann können könnte habe haben hat zimmer nacht nächte buchen buchung reservierung
      personen erwachsene kinder frühstück blick tage oktober september august juli juni mai april heute
      anreise abreise gut perfekt genau sprechen spreche deutsch sprache zwei drei vier name heiße`,
    it: `il lo la gli le un una uno di da del della dei delle al alla allo ai alle dal dalla nel nella
      per con che è e non sono sei siamo ho ha abbiamo hanno mi ti ci si vi come quando dove perché anche
      ma se sì grazie prego buongiorno buonasera ciao salve vorrei posso potrei può vuole volevo
      camera camere notte notti prenotare prenotazione persone adulti bambini colazione vista giorno
      giorni ottobre settembre agosto luglio giugno maggio aprile domani oggi dopodomani arrivo partenza
      bene perfetto certo esatto va benissimo arrivederci nome mio mia nostro nostra questo questa quello
      ecco allora quanto costa quale matrimoniale doppia singola tutto tutti
      parla parlare parlo italiano lingua due tre quattro chiamo favore`,
    es: `el la los las un una unos unas de del al y es son soy estoy está estamos yo tú usted él ella
      nosotros mi mis nuestro nuestra su sus para con en por no que qué quién cómo cuándo dónde cuánto
      sí gracias por favor hola buenos buenas días tardes noches adiós hasta luego quiero quería quisiera
      me gustaría puedo puede podría tengo tiene tenemos hay habitación habitaciones noche reservar reserva
      personas adultos niños desayuno vista día octubre septiembre agosto julio junio mayo abril
      mañana hoy llegada salida bien perfecto vale claro muy hablar habla español idioma dos tres cuatro llamo nombre`,
    nl: `de het een en is zijn was waren ik je jij u hij zij ze wij we jullie mijn onze ons uw voor met van
      naar op aan in bij uit om niet geen dat die dit deze wat wie hoe waar wanneer waarom welke
      ja nee dank bedankt alstublieft hallo goedemorgen goedemiddag goedenavond dag tot ziens wil willen
      zou graag kan kunnen kunt heb heeft hebben kamer kamers nacht nachten boeken boeking reservering
      personen volwassenen kinderen ontbijt uitzicht dagen oktober september augustus juli juni mei april
      morgen vandaag aankomst vertrek goed prima precies spreken spreekt nederlands taal twee drie vier naam heet`,
  };
  const sets = Object.fromEntries(Object.entries(WORDS).map(([k, v]) => [k, new Set(v.split(/\s+/).filter(Boolean))]));
  // Letters and letter groups that point clearly at one language.
  const HINTS = { fr: /[çœêûîë]|eau|oi[srt]?$/, de: /[äöüß]|sch|ung$/, it: /[òùì]|zione$|gli/, es: /[ñ¿¡áóú]|ción$/, nl: /ij|oe|aa|sch$/ };

  // among: the language codes to choose from (default: all six).
  function detect(text, among = Object.keys(WORDS)) {
    const words = String(text || "").toLowerCase().normalize("NFC")
      .replace(/[’`]/g, "'").match(/[\p{L}¿¡][\p{L}'¿¡]*/gu) || [];
    if (!words.length) return null;
    const langs = among.filter((l) => sets[l]);
    const score = Object.fromEntries(langs.map((l) => [l, 0]));
    for (const w of words) {
      // Elisions (l'arrivo, j'aimerais, d'accord) count as their two halves,
      // unless the whole form is a known word (it's, i'd, s'il).
      const parts = w.includes("'") && !langs.some((l) => sets[l].has(w)) ? w.split("'").filter(Boolean) : [w];
      for (const part of parts) {
        for (const l of langs) {
          if (sets[l].has(part)) score[l] += 1;
          else if (HINTS[l]?.test(part)) score[l] += 0.5;
        }
      }
    }
    const ranked = langs.sort((a, b) => score[b] - score[a]);
    const top = score[ranked[0]], margin = top - (score[ranked[1]] ?? 0);
    if (top < 1 || margin <= 0) return null;
    // Short answers ("sì", "yes please") are enough if unambiguous; longer ones need a clear lead.
    if (words.length > 3 && (top < 2 || margin < 1)) return null;
    return ranked[0];
  }

  root.LangDetect = { detect };
})(typeof window !== "undefined" ? window : globalThis);
