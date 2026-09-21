import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Emulate a host loading the production extension only in the delegator.
// With --no-extensions, the child can load metadata only via runner.ts's explicit -e.
export default async function (pi: ExtensionAPI) {
  if (!process.env.PI_SUBAGENT_DEPTH) {
    const { default: subagent } = await import("../../index.ts");
    subagent(pi);
  }
}
