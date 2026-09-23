# 03 — Companion tools: status, result, graceful stop

**What to build:** Three companion tools make background jobs manageable. `subagent_status` lists in-flight jobs with status, elapsed time, and agent name (privacy-filtered: no task text or output in the listing). `subagent_result` collects a finished job's full output without blocking. `subagent_stop` stops a running job gracefully: a wrap-up instruction ("report partial progress"), a bounded grace period, then process-tree termination — the same sequence timeout expiry reuses, so timeouts produce clean partial results instead of cut-off garbage.

**Blocked by:** 02 — Background delivery.

**Status:** ready-for-agent

- [ ] `subagent_status` lists jobs as queued/running/done/failed/stopped with elapsed time and agent name, no task text or output leaking
- [ ] `subagent_result` returns a finished job's full output non-blocking; a still-running job reports not-done
- [ ] `subagent_stop` yields clean partial output via wrap-up before termination; termination kills the process tree (Windows-aware)
- [ ] Timeout expiry follows the same wrap-up → grace → terminate sequence
- [ ] All three tools covered through the integration harness; graceful stop covered at the runner lifecycle seam

*Tracker: hoangvu12/pi-subagent#4*
