# 05 — Mid-run steering

**What to build:** `subagent_steer` sends a message into a running child over its existing RPC channel; pi's native queueing delivers it after the child's current tool call, redirecting the child without killing it. Works for foreground and background jobs; steering a background job while chatting keeps the parent conversation live.

**Blocked by:** 01 — Job registry, `Agent` rename, details contract.

**Status:** ready-for-agent

- [ ] A steering message reaches a running child and changes its course without a restart
- [ ] Delivery lands after the child's current tool call
- [ ] Steering a background job does not block the parent conversation
- [ ] Integration test: the steered child's session shows the injected user message and a changed course

*Tracker: hoangvu12/pi-subagent#6*
