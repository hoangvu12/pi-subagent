# 01 — Job registry, `Agent` rename, details contract

**What to build:** Every delegation runs as a tracked job. The spawn tool is renamed to `Agent` (the Claude Code naming convention), so clients that speak that dialect — roboco in particular — bind their subagent UI to it with zero client changes. Foreground behavior is unchanged: single and parallel calls stream progress and return results as today. What is new: every spawn result carries machine-readable job details (`childSessionId`, `childSessionFile`, `status`, `model`), and the parent session's delegation-origin entries record job identity — the correlation contract every later ticket and the roboco-side tracker depend on.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] The spawn tool is named `Agent`; contract wording, rendering, and docs updated; foreground single/parallel behavior identical to before
- [ ] Every delegation gets a job id and a lifecycle state (spawned → running → done | failed | stopped)
- [ ] Tool result details carry `childSessionId`, `childSessionFile`, `status`, `model`
- [ ] Delegation-origin custom entries in the parent session JSONL record job identity
- [ ] Verified in roboco: an `Agent` call produces a spawn chip with no client changes
- [ ] Existing suite green; contract and integration tests assert the details shape

*Tracker: hoangvu12/pi-subagent#2*
