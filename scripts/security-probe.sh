#!/usr/bin/env bash
# Logged-out security probe of a deployed instance: every page, asset, API and
# socket must refuse anonymous access, with the hardening headers present.
#   npm run probe:live [-- https://other-host]
B=${1:?usage: npm run probe:live -- https://your-deployment}
fail=0
chk() { local want="$1" path="$2"; shift 2; local got=$(curl -s -o /dev/null -w '%{http_code}' "$@" "$B$path"); if [[ " $want " == *" $got "* ]]; then printf "  ok   %-34s %s\n" "$path" "$got"; else printf "  FAIL %-34s %s (want %s)\n" "$path" "$got" "$want"; fail=1; fi; }
echo "Pages → login:"; for p in / /index.html /flow.html /history.html /admin.html /assistant.html /email.html /sms.html; do chk 302 $p; done
echo "Bypass attempts:"; for p in /%61dmin.html /%61ssistant.html /ADMIN.HTML /Assistant.html //admin.html /./assistant.html /assets/../admin.html /%2fassistant.html; do chk "302 400 401 404" $p --path-as-is; done
echo "Assets & data → 401:"; for p in /reception.js /assistant.js /admin.js /history.js /i18n.js /i18n/en.js /reception.css /assets/band.jpg /assets/logo.svg /account.js /api/auth/me /api/calls /api/calls/x /api/messages /api/prefs /api/concierge /api/admin/users /api/admin/assistant /api/admin/concierge /api/admin/email /api/admin/sms /api/admin/sms/profiles /sms.js /recap/x; do chk 401 $p; done
chk 401 /api/admin/concierge -X PUT -H 'Content-Type: application/json' -d '{}'
chk 401 /api/admin/assistant/prompt -X PATCH -H 'Content-Type: application/json' -d '{}'
chk 401 /api/tts -X POST -H 'Content-Type: application/json' -d '{"text":"x"}'
chk 401 /api/booking-recap -X POST -H 'Content-Type: application/json' -d '{}'
chk 401 /api/booking-sms -X POST -H 'Content-Type: application/json' -d '{}'
chk 401 /api/admin/sms -X PUT -H 'Content-Type: application/json' -d '{}'
chk 401 /api/admin/sms/test -X POST -H 'Content-Type: application/json' -d '{}'
chk 401 /api/admin/assistant/avatar -X PATCH -H 'Content-Type: application/json' -d '{}'
echo "Public:"; for p in /login.html /console.css /brand.css /assets/telnyx.svg /assets/hero.jpg /health; do chk 200 $p; done
echo "Robustness:"; chk 401 /api/auth/me -H 'Cookie: telnyxhotel_session=%E0%A4%A'; chk 401 /api/auth/me -H 'Cookie: telnyxhotel_session=eyJ1aWQiOiJ1X3giLCJzdiI6MSwiZXhwIjo5OTk5OTk5OTk5OTk5fQ.AAAA'; chk 200 /health
chk 400 /api/auth/login -X POST -H 'Content-Type: application/json' -d '{oops'
body=$(curl -s -X POST -H 'Content-Type: application/json' -d '{oops' $B/api/auth/login); [[ "$body" == *"node_modules"* || "$body" == *".js:"* ]] && { echo "  FAIL stack trace leaked"; fail=1; } || echo "  ok   no stack trace in errors"
echo "WebSockets → 401 / 403:"
for p in /ws/assistant; do chk 401 $p -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=="; done
chk "401 403" /ws/assistant -H "Origin: https://evil.example" -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=="
echo "Headers:"; h=$(curl -sI $B/login.html); for x in "x-frame-options: DENY" "x-content-type-options: nosniff" "frame-ancestors 'none'" "strict-transport-security" "referrer-policy: same-origin"; do echo "$h" | grep -qi "$x" && echo "  ok   $x" || { echo "  FAIL missing $x"; fail=1; }; done
echo "$h" | grep -qi "x-powered-by" && { echo "  FAIL x-powered-by present"; fail=1; } || echo "  ok   no x-powered-by"
curl -sI $B/api/auth/me | grep -qi "cache-control: no-store" && echo "  ok   API no-store" || { echo "  FAIL API cache"; fail=1; }
echo; [ $fail = 0 ] && echo "LIVE PROBE: ALL PASSED" || echo "LIVE PROBE: FAILURES"
exit $fail
