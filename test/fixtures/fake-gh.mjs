// Fake `gh` for the PR landing seam. Worktree landing resolves the gh command
// from PI_SUBAGENT_GH; pointing it at this file runs it under Node. It records
// the invocation (args and cwd) to FAKE_GH_LOG and prints a fake PR URL, which
// is exactly what the real `gh pr create` prints on success.
import fs from "node:fs";

const log = process.env.FAKE_GH_LOG;
const args = process.argv.slice(2);
if (log) {
  fs.appendFileSync(log, `${JSON.stringify({ pid: process.pid, args, cwd: process.cwd() })}\n`);
}
process.stdout.write("https://pr.example.invalid/pi-subagent-fake-pr\n");
