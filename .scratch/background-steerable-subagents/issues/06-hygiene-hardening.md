# 06 — Hygiene hardening: orphans, caps, budgets, abort, headless

**What to build:** The hygiene layer that makes parallel background work safe to leave unattended. Session end, reload, switch, or fork gracefully stops every owned child, idempotently — no orphans outlive the session (session files persist for later resume). Abort (Esc / Ctrl+C) propagates to children. A concurrency cap with queueing (default 4) replaces unbounded fan-out, and a per-run plus per-session spawn budget rejects runaway delegation with a clear message. Headless print mode exits safely: jobs stopped, the exit reporting which were still running.

**Blocked by:** 02 — Background delivery. 03 — Companion tools: status, result, graceful stop.

**Status:** ready-for-agent

- [ ] Session shutdown / reload / switch / fork stops every owned child; repeated cleanup is a no-op
- [ ] Abort propagates to children
- [ ] N parallel calls queue at the concurrency cap and drain in order
- [ ] The spawn budget rejects excess delegation with a clear message
- [ ] `pi -p` exit stops background jobs and reports which were still running
- [ ] Lifecycle cleanup, queueing, and budget covered at the existing test seams

*Tracker: hoangvu12/pi-subagent#7*
