/**
 * Voice acts immediately. Guarded tools wait for a spoken yes. Delete is
 * refused. Other side effects announce the environment, then run.
 */

import { isConfirmVoiceTool, isDestructiveVoiceTool, isSideEffectVoiceTool } from "./allowlist.ts";

export type SpeakFn = (text: string) => void | Promise<void>;

export type ConfirmationDecision =
  | { readonly action: "proceed"; readonly announce?: string }
  | { readonly action: "reject"; readonly speak: string }
  | { readonly action: "await_confirm"; readonly speak: string };

export interface ConfirmationContext {
  readonly tool: string;
  readonly environmentLabel: string | null;
  readonly args?: Readonly<Record<string, unknown>>;
}

const YES = /\b(yes|yeah|yep|approve|approved|allow|accept|confirm|confirmed|go ahead|do it)\b/iu;
const NO = /\b(no|nope|deny|denied|decline|declined|cancel|stop|don't|do not)\b/iu;

/** No wins when both appear. */
export const parseSpokenAnswer = (utterance: string): "yes" | "no" | undefined => {
  if (NO.test(utterance)) return "no";
  if (YES.test(utterance)) return "yes";
  return undefined;
};

export const decideConfirmation = (ctx: ConfirmationContext): ConfirmationDecision => {
  const label = ctx.environmentLabel?.trim() || "the hub";
  if (isConfirmVoiceTool(ctx.tool)) {
    return {
      action: "await_confirm",
      speak: `Say yes to ${ctx.tool} on ${label}.`,
    };
  }
  if (isDestructiveVoiceTool(ctx.tool)) {
    return {
      action: "reject",
      speak: `${ctx.tool} is blocked for voice. Cap must run it from the UI.`,
    };
  }

  if (isSideEffectVoiceTool(ctx.tool, ctx.args)) {
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
