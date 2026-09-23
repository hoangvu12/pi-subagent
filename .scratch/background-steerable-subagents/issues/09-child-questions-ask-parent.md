# 09 — Child questions: `ask_parent`

**What to build:** Children can ask their parent a question mid-task instead of guessing. A child is given an `ask_parent` tool; the question is relayed into the parent session as a queued message; the parent answers via `subagent_reply`; the child unblocks on the answer — or on its own timeout, with the timeout reported back to the parent.

**Blocked by:** 02 — Background delivery. 05 — Mid-run steering.

**Status:** ready-for-agent

- [ ] A child can ask a question mid-task; it arrives in the parent session as a queued turn
- [ ] `subagent_reply` delivers the answer; the child continues using it
- [ ] The child unblocks on its own timeout if unanswered; the parent is informed of the timeout
- [ ] Integration test: a child asks, the parent answers, and the task completes using the answer

*Tracker: hoangvu12/pi-subagent#10*
