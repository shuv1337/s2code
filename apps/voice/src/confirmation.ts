/**
 * Voice acts immediately. Guarded calls wait for a spoken yes. The yes applies
 * only to the arguments captured on that call. Delete is refused.
 */

import {
  isDestructiveVoiceTool,
  isSideEffectVoiceTool,
  needsSpokenConfirmation,
} from "./allowlist.ts";

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

const named = (
  args: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined => {
  const value = args?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

/** Ids and modes captured on the tool call. A later yes cannot change them. */
export const confirmationTarget = (ctx: ConfirmationContext): string => {
  const label = ctx.environmentLabel?.trim() || "the hub";
  const environmentId = named(ctx.args, "environmentId");
  const threadId = named(ctx.args, "threadId");
  const projectId = named(ctx.args, "projectId");
  const action = named(ctx.args, "action");
  const mode = named(ctx.args, "mode");
  const hint = named(ctx.args, "hint");
  const url = named(ctx.args, "url");
  return [
    `on ${label}`,
    ...(environmentId === undefined ? [] : [`environment ${environmentId}`]),
    ...(threadId === undefined ? [] : [`thread ${threadId}`]),
    ...(projectId === undefined ? [] : [`project ${projectId}`]),
    ...(hint === undefined ? [] : [`hint ${hint}`]),
    ...(url === undefined ? [] : [`url ${url}`]),
    ...(action === undefined ? [] : [`action ${action}`]),
    ...(mode === undefined ? [] : [`mode ${mode}`]),
  ].join(", ");
};

export const decideConfirmation = (ctx: ConfirmationContext): ConfirmationDecision => {
  const label = ctx.environmentLabel?.trim() || "the hub";
  if (needsSpokenConfirmation(ctx.tool, ctx.args)) {
    return {
      action: "await_confirm",
      speak: `Say yes to ${ctx.tool} ${confirmationTarget(ctx)}.`,
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
