# 08 — pi-acp fork: wire lifecycle

**What to build:** Fork the pinned ACP adapter and translate job lifecycle into wire-level subagent events: `subagent_spawned` / `subagent_progress` / `subagent_finished` extension updates, plus a `_meta` subagent-support capability declaration — the same pattern another agent's adapter uses. This is an adapter-level change (extensions cannot emit arbitrary ACP events); the extension side already exposes everything needed via tool events and details. Lands in the pi-acp fork repository; roboco pins the fork.

**Blocked by:** 01 — Job registry, `Agent` rename, details contract. 02 — Background delivery.

**Status:** ready-for-agent

- [ ] Lifecycle updates are emitted on the ACP wire for spawn, progress, and finish
- [ ] The `_meta` capability is declared
- [ ] Verified in roboco: chip status flips live during a run, no client changes
- [ ] Adapter tested against a recorded session fixture; an upstream PR to the adapter is optional follow-up

*Tracker: hoangvu12/pi-subagent#9*
