import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createVoiceEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    status: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "voice:status",
      tag: WS_METHODS.voiceStatus,
      staleTimeMs: 0,
    }),
    configure: createEnvironmentRpcCommand(runtime, {
      label: "voice:configure",
      tag: WS_METHODS.voiceConfigure,
    }),
    start: createEnvironmentRpcCommand(runtime, {
      label: "voice:start",
      tag: WS_METHODS.voiceStart,
    }),
    end: createEnvironmentRpcCommand(runtime, { label: "voice:end", tag: WS_METHODS.voiceEnd }),
    execute: createEnvironmentRpcCommand(runtime, {
      label: "voice:execute",
      tag: WS_METHODS.voiceExecute,
    }),
    confirm: createEnvironmentRpcCommand(runtime, {
      label: "voice:confirm",
      tag: WS_METHODS.voiceConfirm,
    }),
  };
}
