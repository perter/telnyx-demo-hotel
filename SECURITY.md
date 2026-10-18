# Security

## Reporting a vulnerability

Please don't open a public issue for a security problem. Report it privately
through Telnyx's security channels (see https://telnyx.com/security, or
[GitHub private vulnerability reporting](https://docs.github.com/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository), with the steps to reproduce it. We'll acknowledge it and
keep you posted until it's fixed.

## Keeping your deployment safe

- Never commit `.env`: it holds your Telnyx API key, the session secret and the
  first admin's password. It is in `.gitignore`; keep it that way.
- If a key leaks, revoke it in the Telnyx Portal (API Keys) and create a new one.
- Serve the app over HTTPS only, change the generated admin password after the
  first login, and give users only the pages they need (Users & access).
- After a deploy, run `npm run probe:live -- https://your-deployment` to check that
  everything but the login page refuses anonymous access.
