---
description: Split a spec into tasks and implement them in parallel on git worktrees
argument-hint: <spec-file-or-text> [landing]
---

Implement the spec below by splitting it into tasks and running them in parallel as worktree subagent jobs.

Spec: ${1:-the spec discussed in this conversation}

Landing policy for every task: ${2:-patch}

Workflow:

1. Read the spec end to end. Split it into independent implementation tasks — aim for two to six tasks; more than eight do not fit a single Agent invocation, so run additional batches after the first completes. Write each task prompt as complete and self-contained: goal, files or areas to touch, acceptance criteria, and the task's slice of the spec verbatim. Tasks must not need each other's uncommitted changes to make sense.
2. Fan out every task in ONE `Agent` tool invocation, one call per task:

   ```json
   {"calls":[{"agent":"<implementation agent>","prompt":"<task prompt>","worktree":true,"landing":"<landing policy>","background":true}]}
   ```

   Each child runs in its own isolated git worktree on a dedicated branch (`pi-subagent/<job-id>`), so parallel tasks never conflict. Instruct each child to work on the current branch and commit its changes before returning its final response; uncommitted work does not reach the patch or PR. If the Agent tool rejects `background` calls, send the same batched calls without `background` and wait for them to finish.
3. Collect results. While jobs run, poll the `subagent_status` tool; when a job finishes, fetch its full output with `subagent_result` if you need more than the delivered summary. If those tools are unavailable, rely on the tool results and delivered background messages.
4. Report a table of every task with: task name, job id, status (`done`/`failed`/`stopped`), and landing status — the kept branch and worktree location, the patch file path, or the PR URL from the result's landing details. For failed or stopped tasks, summarize the partial output and include the child session id so the work can be resumed with a corrective follow-up call instead of a restart.
5. Do not merge branches, apply patches, or open additional PRs yourself unless the user asks; the landing policy already acted per task. Verify each patch or PR only if the user requests a review.
