// Reservation rules and demo availability/pricing used by the receptionist's
// client-side tools. Pure functions — exposed as window.Booking (and testable
// under Node). All prices and availability are deterministic demo data.
(function (root) {
  // A fictional chain: ten city hotels in six cities. `city` picks the
  // translated location line (i18n key loc.<city>); `factor` scales the prices.
  const HOTELS = {
    chicago_riverwalk: { name: "TelnyxHotel Chicago Riverwalk", short: "Chicago Riverwalk", city: "chicago", factor: 1.2 },
    chicago_lakeshore: { name: "TelnyxHotel Chicago Lakeshore", short: "Chicago Lakeshore", city: "chicago", factor: 1.1 },
    rome_centro: { name: "TelnyxHotel Rome Centro Storico", short: "Rome Centro Storico", city: "rome", factor: 1.25 },
    rome_trastevere: { name: "TelnyxHotel Rome Trastevere", short: "Rome Trastevere", city: "rome", factor: 1.05 },
    paris_marais: { name: "TelnyxHotel Paris Le Marais", short: "Paris Le Marais", city: "paris", factor: 1.3 },
    paris_rive_gauche: { name: "TelnyxHotel Paris Rive Gauche", short: "Paris Rive Gauche", city: "paris", factor: 1.2 },
    munich_altstadt: { name: "TelnyxHotel Munich Altstadt", short: "Munich Altstadt", city: "munich", factor: 1.0 },
    madrid_gran_via: { name: "TelnyxHotel Madrid Gran Vía", short: "Madrid Gran Vía", city: "madrid", factor: 0.95 },
    madrid_retiro: { name: "TelnyxHotel Madrid Retiro", short: "Madrid Retiro", city: "madrid", factor: 1.0 },
    amsterdam_canal: { name: "TelnyxHotel Amsterdam Canal Ring", short: "Amsterdam Canal Ring", city: "amsterdam", factor: 1.15 },
  };
  const ROOMS = {
    essential: { name: "Essential Room", base: 140, max: 2 },
    deluxe: { name: "Deluxe City View", base: 190, max: 3 },
    family_studio: { name: "Family Studio", base: 260, max: 4 },
    skyline_suite: { name: "Skyline Suite", base: 380, max: 4 },
  };
  const MAX_GUESTS = 4;
  const MAX_NIGHTS = 30;

  // "YYYY-MM-DD" → local Date, or null if malformed / not a real date.
  function parseISO(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? "").trim());
    if (!m) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    return d.getMonth() === +m[2] - 1 && d.getDate() === +m[3] ? d : null;
  }
  const toISO = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const nightsBetween = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / 86_400_000);

  // High season Jul–Aug, shoulder Jun & Sep, low otherwise.
  function seasonFactor(d) {
    const m = d.getMonth();
    if (m === 6 || m === 7) return 1.4;
    if (m === 5 || m === 8) return 1.15;
    return 0.9;
  }

  function hash(str) { // FNV-1a
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  }

  // Validate a stay (hotel, dates, guests). Returns { errors, ci, co, nights, guests }.
  function validateStay({ hotel, check_in, check_out, adults, children }, today) {
    const errors = [];
    if (!HOTELS[hotel]) errors.push(`unknown hotel "${hotel}"; use one of: ${Object.keys(HOTELS).join(", ")}`);
    const ci = parseISO(check_in), co = parseISO(check_out);
    if (!ci) errors.push("check_in must be a valid date in YYYY-MM-DD format");
    if (!co) errors.push("check_out must be a valid date in YYYY-MM-DD format");
    let nights = null;
    if (ci && co) {
      nights = nightsBetween(ci, co);
      if (ci < startOfDay(today)) errors.push("check_in is in the past");
      if (nights < 1) errors.push("check_out must be after check_in");
      if (nights > MAX_NIGHTS) errors.push(`stays are limited to ${MAX_NIGHTS} nights`);
    }
    const a = Number(adults), c = Number(children || 0);
    if (!Number.isInteger(a) || a < 1) errors.push("adults must be at least 1");
    if (!Number.isInteger(c) || c < 0) errors.push("children must be 0 or more");
    const guests = a + c;
    if (guests > MAX_GUESTS) errors.push(`maximum ${MAX_GUESTS} guests per room; suggest booking a second room with a colleague`);
    return { errors, ci, co, nights, guests };
  }

  function checkAvailability(stay, today = new Date()) {
    const v = validateStay(stay, today);
    if (v.errors.length) return { ok: false, errors: v.errors };

    const hotel = HOTELS[stay.hotel];
    let season = 0;
    for (let i = 0; i < v.nights; i++) {
      season += seasonFactor(new Date(v.ci.getFullYear(), v.ci.getMonth(), v.ci.getDate() + i));
    }
    season /= v.nights;

    const rooms = Object.entries(ROOMS).map(([id, r]) => {
      const perNight = Math.round((r.base * hotel.factor * season) / 5) * 5;
      const soldOut = hash(`${stay.hotel}|${stay.check_in}|${stay.check_out}|${id}`) % 5 === 0;
      const fits = v.guests <= r.max;
      return {
        room_type: id,
        name: r.name,
        max_guests: r.max,
        available: fits && !soldOut,
        reason: !fits ? `room holds max ${r.max} guests` : soldOut ? "sold out for these dates" : undefined,
        price_per_night_eur: perNight,
        total_eur: perNight * v.nights,
      };
    });
    // Always leave something bookable when the party fits in a room.
    if (!rooms.some((r) => r.available)) {
      const fallback = rooms.find((r) => v.guests <= r.max_guests);
      if (fallback) { fallback.available = true; delete fallback.reason; }
    }
    return {
      ok: true,
      hotel: stay.hotel,
      hotel_name: hotel.name,
      check_in: stay.check_in,
      check_out: stay.check_out,
      nights: v.nights,
      guests: v.guests,
      rooms,
      note: "Prices include breakfast and VAT. Demo data.",
    };
  }

  const REQUIRED = ["hotel", "check_in", "check_out", "adults", "room_type", "guest_name"];

  function missingFields(b) {
    const missing = REQUIRED.filter((k) => b[k] == null || b[k] === "");
    if (!b.phone && !b.email) missing.push("phone or email");
    return missing;
  }

  // Unambiguous characters only (no 0/O, 1/I) so it can be spelled out loud.
  function confirmationCode(rand = Math.random) {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "TH";
    for (let i = 0; i < 6; i++) code += alphabet[Math.floor(rand() * alphabet.length)];
    return code;
  }

  root.Booking = {
    HOTELS, ROOMS, MAX_GUESTS,
    parseISO, toISO, nightsBetween, validateStay, checkAvailability, missingFields, confirmationCode,
  };
})(typeof window !== "undefined" ? window : globalThis);
