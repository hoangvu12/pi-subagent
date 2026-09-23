# 07 — Worktrees, landing, cleanup

**What to build:** A call with `worktree: true` runs its child in an isolated git worktree on a dedicated branch, so parallel implementation never conflicts. `landing` controls what happens after: `keep` leaves the branch for review (default), `patch` writes a patch file and removes the worktree, `pr` pushes the branch and opens a PR via `gh` then removes the worktree. Cleanup honors the landing policy on every exit path, including failure and stop.

**Blocked by:** 01 — Job registry, `Agent` rename, details contract.

**Status:** ready-for-agent

- [ ] A worktree call runs the child in an isolated worktree on its own branch; the branch is recorded in job details
- [ ] `keep` leaves the branch; `patch` writes a patch and removes the worktree; `pr` opens a PR and removes the worktree
- [ ] No worktree debris after failure or stop paths
- [ ] Tested against real temporary git repositories; the `gh` invocation faked at the process seam

*Tracker: hoangvu12/pi-subagent#8*
