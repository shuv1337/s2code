/**
 * Spoken confirmation policy for the voice orchestrator.
 *
 * Cap decision: voice acts from day one; spoken confirmation ONLY for
 * destructive tools. Destructive tools are also kept OFF the allowlist, so
 * the runtime path is: reject + speak that Cap must use the UI (no MCP call).
 * Side-effecting allowlisted tools do NOT wait for "yes" — they announce the
 * environment name, then run.
 */

import { isDestructiveVoiceTool, isSideEffectVoiceTool } from "./allowlist.ts";

export type SpeakFn = (text: string) => void | Promise<void>;

export type ConfirmationDecision =
  | { readonly action: "proceed"; readonly announce?: string }
  | { readonly action: "reject"; readonly speak: string }
  | { readonly action: "await_confirm"; readonly speak: string };

export interface ConfirmationContext {
  readonly tool: string;
  readonly environmentLabel: string | null;
  /** When true, a prior spoken "yes" for this destructive request was heard. */
  readonly destructiveConfirmed?: boolean;
}

/**
 * Decide whether to proceed, reject, or (if ever allowlisted) await confirm.
 * Destructive tools always reject at the gate unless somehow allowlisted AND
 * `destructiveConfirmed` — still never auto-run.
 */
export const decideConfirmation = (ctx: ConfirmationContext): ConfirmationDecision => {
  if (isDestructiveVoiceTool(ctx.tool)) {
    if (ctx.destructiveConfirmed) {
      // Still refuse: destructive tools stay off the allowlist by policy.
      return {
        action: "reject",
        speak: `I cannot run ${ctx.tool} from voice. Use the desktop UI.`,
      };
    }
    return {
      action: "reject",
      speak: `${ctx.tool} is blocked for voice. Cap must run it from the UI.`,
    };
  }

  if (isSideEffectVoiceTool(ctx.tool)) {
    const label = ctx.environmentLabel?.trim() || "the hub";
    return {
      action: "proceed",
      announce: `On ${label}.`,
    };
  }

  return { action: "proceed" };
};

/** Apply a confirmation decision: speak announcements/rejects via `speak`. */
export const applyConfirmation = async (
  decision: ConfirmationDecision,
  speak: SpeakFn,
): Promise<"proceed" | "reject" | "await_confirm"> => {
  if (decision.action === "proceed") {
    if (decision.announce) await speak(decision.announce);
    return "proceed";
  }
  await speak(decision.speak);
  return decision.action;
};
