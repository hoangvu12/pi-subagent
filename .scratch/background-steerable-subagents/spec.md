# Spec: Background-first, steerable, roboco-visible subagents

## Problem Statement

I use pi as my agent engine inside roboco (a desktop client that drives coding agents over ACP). My two daily subagent workloads are:

1. **`/implement-spec`** — split a spec into tasks and implement them in parallel on isolated git worktrees, fast.
2. **Research / information gathering** — fan out scouts to read code, gather facts, and report back.

The current delegation extension (mjakl/pi-subagent, which this repo forks) handles parallel fan-out, guards, and named sessions, but from my perspective it has four failures:

- **It freezes the chat.** A subagent call blocks the main conversation until every child finishes. I cannot keep talking to the main agent while work runs.
- **Failures destroy progress.** A child that dies on a small bug — often an upstream fault, not a task fault — returns an error and the work is gone. There is no "resume where it died with a fix."
- **No mid-run steering.** Once a child is running there is no way to redirect it. The only options are wait or kill.
- **Roboco is blind to it.** Subagents render as a plain tool call with a final blob of output. No spawn chips, no live child transcripts, no running/done/failed status — even though roboco has a native subagent UI waiting for exactly this.

## Solution

Fork mjakl/pi-subagent into a background-first, steerable, fail-soft delegation system that is observable natively in roboco:

- Spawn many subagents in parallel, each in the background: the tool returns job ids immediately, the chat stays live, and each result is injected back as a queued turn whenever it finishes.
- Steer running subagents mid-run; stop them with a graceful wrap-up; resume a failed one from its persisted session with a corrective prompt so no progress is ever lost.
- Run parallel implementation on per-job git worktrees with branch/patch/PR landing — the basis of an `/implement-spec` workflow.
- Surface everything to roboco through its existing subagent UI contract: spawn chips via the `Agent` naming convention, live child transcripts via tailed session files, and lifecycle on the wire via the pinned ACP adapter.

## User Stories

### Parallel fan-out

1. As a main agent, I want to issue several subagent calls in one tool invocation, so that they all start at once instead of sequentially.
2. As a user, I want a configurable concurrency cap with queueing, so that ten parallel calls do not melt my provider rate limits.
3. As a user, I want a per-run and per-session spawn budget, so that a runaway delegation loop cannot silently burn tokens.
4. As a main agent, I want per-child output caps in my context, so that five verbose children cannot flood and compact my own conversation.

### Background execution

5. As a user, I want to launch subagents in the background, so that the tool call returns immediately with job ids and the chat never freezes.
6. As a user, I want to keep chatting with the main agent while background jobs run, so that I am never blocked on a slow child.
7. As a main agent, I want each finished background job's result delivered to me as a queued message when I am idle, so that I can fold it into my next reply no matter when it lands.
8. As a main agent, I want a failure notification delivered the same way, so that I can react to a dead child promptly instead of discovering it on the next status check.
9. As a user, I want to list background jobs with their status (queued/running/done/failed/stopped), elapsed time, and agent, so that I always know what is in flight.
10. As a user, I want to collect a finished job's full output on demand, so that the main context only ever pays for a capped summary.
11. As a user, I want running jobs to be stopped gracefully when my session ends, reloads, or switches, so that no orphaned child processes outlive the session that owns them.

### Steering and interruption

12. As a main agent, I want to send a message into a running subagent mid-run, so that I can redirect it after its current tool call without killing it.
13. As a user, I want to ask a running subagent a question through the main agent, so that I can clarify scope without stopping the work.
14. As a user, I want to stop a subagent with a graceful wrap-up — a final "report partial progress" signal with a grace period before termination, so that timeouts produce clean partial results instead of cut-off garbage.
15. As a user, I want abort (Esc / Ctrl+C) to propagate to all children, so that interrupting the parent never leaves strays.

### Fail-soft and resume

16. As a user, I want every child's session persisted incrementally as it runs, so that any moment of failure leaves a resumable transcript on disk.
17. As a main agent, I want a failed child's tool result to include its partial output, its session handle, and resume guidance, so that my natural next move is one corrective call, not a restart from zero.
18. As a main agent, I want to resume a session by handle with a new prompt, so that "the bug was X, continue from where you died" actually works.
19. As a user, I want named persistent sessions to keep working as before, so that multi-turn specialist conversations survive across parent turns.

### Worktrees and `/implement-spec`

20. As a main agent, I want a per-call worktree option that creates an isolated git worktree on its own branch and runs the child there, so that parallel implementation never conflicts.
21. As a user, I want landing options per worktree job — keep branch (default), produce a patch, or open a PR via `gh` — so that I can review merged work my way.
22. As a user, I want an `/implement-spec` prompt template that splits a spec into tasks, fans them out as background worktree jobs, collects results, and reports landing status, so that spec-to-parallel-implementation is one command.
23. As a user, I want worktrees and their branches cleaned up or kept according to the landing policy, so that my repo does not accumulate job debris.

### Research workflows

24. As a user, I want read-only research agents (explore, oracle) to remain first-class, so that information gathering keeps its cheap, parallel shape.
25. As a main agent, I want a child to be able to ask its parent a clarifying question mid-task and block briefly for the answer, so that a research agent does not guess when one question would fix its course.

### Roboco visibility

26. As a roboco user, I want the spawn tool named `Agent`, so that roboco's existing subagent chip UI binds to it with zero client changes.
27. As a roboco user, I want every spawn result to carry machine-readable job details (child session id, session file path, status, model, worktree branch), so that roboco can correlate chips to transcripts.
28. As a roboco user, I want subagent lifecycle (spawned / progress / finished) on the ACP wire as extension updates, so that roboco's tracker flips chip status live without scraping.
29. As a roboco user, I want a running subagent's transcript to appear live in roboco's subagent panel by tailing its session file, so that I can watch children work without switching tools.
30. As a roboco user, I want a finished subagent's session openable in the transcript browser afterwards, so that I can audit what a child actually did.
31. As a roboco user, I want all of this to degrade fail-soft — if a transcript cannot be parsed, the chip and final output still render — so that an extension or format hiccup never breaks my session.

### Safety and hygiene

32. As a user, I want the existing guards kept — depth and cycle prevention, inactivity watchdog, session locks for same-handle parallel use, project-agent trust gating — so that power does not cost safety.
33. As a user, I want behavior in headless print mode documented and safe (jobs are stopped or explicitly reported as lost on exit), so that `pi -p` never surprises me.
34. As a terminal user, I want the existing collapsed/expanded TUI rendering to keep working for foreground calls, so that terminal sessions do not regress.

## Implementation Decisions

### Job architecture

- An in-extension **job registry** owns every child for the lifetime of the parent session. A job is `{ id, agent, status, childSessionId, childSessionFile, model, cwd, worktree?, spawnedAt }` with lifecycle `spawned → running → done | failed | stopped`.
- Every child remains a **real pi process in RPC mode** (the fork base already spawns children this way). The extension holds the RPC channel; this is what makes steering, graceful stop, and live event streaming possible without inventing a new protocol.
- The registry is in-memory and scoped to the session; child session files on disk are the durability layer. If the parent dies, children are stopped and their sessions remain resumable by handle.

### Tool contract

- The spawn tool is renamed **`Agent`** (Claude Code dialect). This matches roboco's subagent genus gate — a naming convention over any tool called `Agent` / `Agent: <description>` — so spawn chips appear with zero roboco changes, and other Claude Code-compatible clients benefit too.
- The unified multi-call shape is retained: one tool invocation carries one or more calls, each with the existing fields (agent, prompt, model, thinking, cwd, initialContext, session, timeout, inactivityTimeout) plus new fields: **`background`** (boolean), **`worktree`** (boolean), **`landing`** (`keep` | `patch` | `pr`).
- Companion tools, all ordinary (non-spawn) tools: **`subagent_status`** (list jobs, privacy-filtered), **`subagent_result`** (collect a finished job's output, non-blocking), **`subagent_steer`** (send a message to a running job), **`subagent_stop`** (graceful stop), **`subagent_reply`** (answer a child's question).

### Background delivery

- Background calls return job ids from the tool call immediately; the child keeps running detached from the tool invocation.
- On completion or failure, the extension injects a compact result summary into the parent session as a **queued user message with follow-up delivery** (pi's native mechanism: delivered as a new turn when the parent agent is idle; queued meanwhile). Full output is not injected — it is capped per child and remains retrievable via `subagent_result` and in tool details.
- Foreground behavior is unchanged: a non-background call streams progress and returns results in the tool result, as today.

### Steering, stop, and resume

- **Steering** sends a user message over the child's existing RPC channel; pi's native queueing delivers it after the child's current tool call.
- **Graceful stop** sends a wrap-up instruction, waits a bounded grace period, then terminates the process tree (Windows-aware). Timeout paths use the same sequence.
- **Resume** generalizes the existing named-session mechanism to all jobs: every job's child session id is a resumable handle. A failed job's result embeds partial output + handle + guidance; a new call with `session: <handle>` and a corrective prompt continues from the persisted session file.
- **Child questions** (ask-parent): children are given a small `ask_parent` tool; a question is relayed into the parent session as a queued message, the parent answers via `subagent_reply`, and the child unblocks (with its own timeout) on the reply.

### Worktrees

- A `worktree` call creates `git worktree add` on a dedicated branch under a predictable prefix, sets the child's cwd to it, and records the branch in job details.
- Landing: `keep` leaves the branch for review (default), `patch` writes a patch file and removes the worktree, `pr` pushes the branch and opens a PR via `gh`, then removes the worktree.
- `/implement-spec` ships as a prompt template in the repo: split the spec, fan out background worktree jobs, collect, report landing.

### Caps, budgets, cleanup

- Per-child output cap (default 50 KB) applies to anything injected into the parent context; full output stays in tool details and the session file.
- Concurrency cap with queueing (default 4, configurable) and a spawn budget per run and per session.
- Orphan cleanup on session shutdown / reload / new / resume / fork is idempotent: graceful-stop every owned child; session files persist.
- All existing guards are kept unchanged: depth + cycle prevention, inactivity watchdog, session locks, project-agent trust gating.

### Roboco observability contract

- Every spawn tool result carries structured **details**: `childSessionId`, `childSessionFile`, `status`, `model`, and worktree `branch` when present. The pinned ACP adapter already forwards tool details, so roboco receives the correlation handle with no new protocol.
- Tool call updates stream progress lines during runs (children already emit events; they are surfaced as partial results).
- The existing delegation-origin custom entries in the parent session JSONL (child/parent session ids, agent, handle) are kept and extended with job status, so any client reading the session file can reconstruct the delegation tree.
- **Wire lifecycle**: the pinned `pi-acp` adapter is forked to translate job lifecycle into ACP extension updates (`subagent_spawned` / `subagent_progress` / `subagent_finished`) and to declare a `_meta` subagent-support capability — the same pattern Devin uses. This is an adapter change, not an extension protocol change: extensions cannot emit arbitrary ACP events.
- **Roboco-side tracker** (landed in the roboco repository, tracked there): binds `Agent` chips to `childSessionFile` from details, tails the child's session JSONL (pi's documented session format), routes tagged subagent events into the child's own doc, and flips chip status — mirroring roboco's existing subagent tracker for another agent, which correlates chips to on-disk transcripts the same way. Fail-soft everywhere: any parse or correlation miss degrades to chip + final output.

### Headless behavior

- In print mode (`pi -p`) the process exits after prompts; background jobs are stopped with their sessions persisted and the exit reports which jobs were still running. RPC mode (roboco) keeps the session open and is the primary target.

## Testing Decisions

- A good test asserts **external behavior only**: tool results, details shapes, session JSONL entries, injected queued messages, child process lifecycle effects, and files on disk (sessions, worktrees, patches). Never internals.
- **Primary seam (existing, highest):** the end-to-end integration harness that drives real pi sessions with the fake delegation provider fixture. Background delivery, steering, resume, worktree landing, and the details contract are all tested through it — assert on what the parent session and tool results look like, exactly as the current suite does for delegation origins.
- **Runner lifecycle seam (existing):** child spawn/stop/timeout tests extended for graceful wrap-up, process-tree termination, and resume-on-session-file.
- **Worktree landing:** real temporary git repositories as fixtures, asserting branches, patches, and PR-branch pushes (the `gh` call is faked at the process seam).
- **Roboco tracker (in the roboco repository):** recorded session JSONL fixtures, including truncated and malformed lines, asserting fail-soft degradation.
- Prior art: the fork base's existing `node:test` suite and its fake-provider fixture pattern.

## Out of Scope

- TUI fleet views, live widgets, and conversation overlays (roboco is the UI; the existing foreground rendering stays as-is).
- A scripted workflow orchestration engine (no pipeline/parallel DSL — `/implement-spec` is a prompt template, not a runtime).
- Nested subagent delegation UI (the depth guard stays; children do not get their own spawn tool).
- Republishing under a new npm scope (install via git for now).
- Any change to pi core.

## Further Notes

- **Migration:** the currently installed `@tintinweb/pi-subagents` registers a tool named `Agent` too — it must be uninstalled before enabling this fork, or the two will clash.
- **Upstream discipline:** keep changes additive and mergeable against mjakl/pi-subagent, which is actively maintained; retain the MIT attribution.
- **Suggested build order:** job registry and lifecycle → background delivery + companion tools → fail-soft resume + graceful stop → steering → worktrees + `/implement-spec` → details contract (roboco correlation) → pi-acp fork lifecycle translation → child questions → caps/budget polish.
- **Roboco-side work** (tracker + adapter pin swap) happens in the roboco repository and gets its own spec there; this spec defines the contract it depends on.
- Minimum pi version: 0.87.0 (RPC-mode child protocol and extension message queueing as documented).
