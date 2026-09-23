# 02 — Background delivery

**What to build:** A call with `background: true` returns job ids immediately — the main conversation never freezes while children run. When a background job finishes (or fails), a compact result summary is injected into the parent session as a queued message, delivered as a new turn whenever the parent agent is idle. Full output is never injected: summaries respect a per-child output cap, and the full text stays retrievable in tool details. Foreground calls behave exactly as before.

**Blocked by:** 01 — Job registry, `Agent` rename, details contract.

**Status:** ready-for-agent

- [ ] A background call returns immediately with job ids; the chat stays usable while children run
- [ ] Completion injects a result summary as a queued user message that arrives as a new turn when the parent is idle
- [ ] Failure injects a failure notification the same way
- [ ] Injected summaries respect the per-child output cap (default 50 KB); full output remains in tool details
- [ ] Foreground calls are unchanged
- [ ] Integration tests assert: immediate return, the queued message landing in the session, cap enforcement

*Tracker: hoangvu12/pi-subagent#3*
