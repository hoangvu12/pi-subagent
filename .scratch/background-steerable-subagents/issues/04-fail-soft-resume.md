# 04 — Fail-soft resume

**What to build:** A failed job never destroys progress. Children already persist their sessions incrementally, so a failure result carries the partial output, the session handle, and guidance to resume — and a new call with that handle plus a corrective prompt continues the persisted child session from where it died. The existing named-session continuation keeps working unchanged; this generalizes resume to every job.

**Blocked by:** 01 — Job registry, `Agent` rename, details contract.

**Status:** ready-for-agent

- [ ] A failed child's result includes partial output, its session handle, and resume guidance
- [ ] A call with the handle continues the child's persisted session — the child retains context from before the failure
- [ ] Existing named-session continuation is unaffected
- [ ] Integration test: a child fails mid-task; one corrective resume call completes the task using the prior progress

*Tracker: hoangvu12/pi-subagent#5*
