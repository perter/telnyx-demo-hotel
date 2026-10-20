// Guest demo only: a pop-up that slides in from the left and asks the guest
// to leave an e-mail or phone number to be contacted by Telnyx about
// TelnyxHotel (POST /api/contact, with consent). It shows once per guest
// session, 20 s after the page opens or a few seconds after a call ends,
// never during a call; closing it or sending it keeps it closed.
(function () {
  const FIRST_DELAY = 20_000;
  const AFTER_CALL = 3_000;
  const t = (key) => I18N.t(key);

  Account.ready.then(({ user }) => {
    if (!user.guest) return;
    const key = `telnyxhotel.contact.${user.id}`;
    const seen = () => { try { return !!localStorage.getItem(key); } catch { return false; } };
    const remember = (v) => { try { localStorage.setItem(key, v); } catch { /* ignore */ } };
    if (seen()) return;

    let inCall = false, shown = false, timer = null;
    const later = (ms) => { clearTimeout(timer); timer = setTimeout(() => !inCall && show(), ms); };
    document.addEventListener("concierge:call_start", () => { inCall = true; clearTimeout(timer); });
    document.addEventListener("concierge:call_end", () => { inCall = false; if (!shown) later(AFTER_CALL); });
    later(FIRST_DELAY);

    function show() {
      if (shown || seen()) return;
      shown = true;
      const box = document.createElement("aside");
      box.className = "contact-pop";
      box.setAttribute("role", "dialog");
      box.setAttribute("aria-labelledby", "contactTitle");
      box.innerHTML = `
        <button type="button" class="contact-close" data-i18n-attr="aria-label:contact.close" aria-label="Close">×</button>
        <h3 id="contactTitle" data-i18n="contact.title"></h3>
        <p data-i18n="contact.text"></p>
        <form novalidate>
          <label><span data-i18n="contact.email"></span><input name="email" type="email" autocomplete="email" maxlength="254"></label>
          <span class="contact-or" data-i18n="contact.or"></span>
          <label><span data-i18n="contact.phone"></span><input name="phone" type="tel" autocomplete="tel" maxlength="30" placeholder="+1 555 010 0000"></label>
          <label class="contact-consent"><input name="consent" type="checkbox"> <span data-i18n="contact.consent"></span></label>
          <p class="contact-error" role="alert"></p>
          <button type="submit" class="btn btn-primary" data-i18n="contact.send"></button>
        </form>`;
      I18N.apply(box);
      document.body.append(box);
      requestAnimationFrame(() => requestAnimationFrame(() => box.classList.add("open")));

      const close = () => {
        box.classList.remove("open");
        setTimeout(() => box.remove(), 600);
      };
      box.querySelector(".contact-close").onclick = () => { remember("closed"); close(); };

      const form = box.querySelector("form");
      const error = box.querySelector(".contact-error");
      form.onsubmit = async (e) => {
        e.preventDefault();
        const email = form.email.value.trim(), phone = form.phone.value.trim();
        if (!email && !phone) return (error.textContent = t("contact.needOne"));
        if (!form.consent.checked) return (error.textContent = t("contact.needConsent"));
        error.textContent = "";
        form.querySelector("[type=submit]").disabled = true;
        try {
          await Account.api("POST", "/api/contact", { email, phone, consent: true, lang: I18N.lang });
          remember("sent");
          form.outerHTML = `<p class="contact-thanks" data-i18n="contact.thanks"></p>`;
          I18N.apply(box);
          setTimeout(close, 4000);
        } catch {
          error.textContent = t("contact.failed");
          form.querySelector("[type=submit]").disabled = false;
        }
      };
    }
  });
})();
