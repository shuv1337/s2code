import { useParams } from "@tanstack/react-router";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { useEnvironment, usePrimaryEnvironmentId } from "../state/environments";
import { useThreadShell } from "../state/entities";
import { primaryServerKeybindingsAtom } from "../state/server";
import { registerCommands } from "../shortcuts/dispatcher";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { VoiceController, type VoiceTarget } from "@t3tools/client-runtime/voice/controller";
import { createVoiceEnvironmentAtoms } from "@t3tools/client-runtime/state/voice";
import {
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommand,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  createContext,
  useContext,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { connectionAtomRuntime } from "../connection/runtime";
import { WebRtcVoiceTransport } from "./WebRtcVoiceTransport";

export const voiceEnvironment = createVoiceEnvironmentAtoms(connectionAtomRuntime);
function unwrap<A, E>(result: AtomCommandResult<A, E>): A {
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
}
const VoiceContext = createContext<{
  controller: VoiceController;
  open: boolean;
  openForCurrent: () => void;
  setOpen: (open: boolean) => void;
  startDictation: (target: VoiceTarget, commit: (text: string) => boolean) => void;
  finishDictation: () => Promise<void>;
  draftMessage: string | null;
} | null>(null);

export function VoiceProvider({ children }: { children: ReactNode }) {
  const registry = useContext(RegistryContext);
  const route = resolveThreadRouteTarget(useParams({ strict: false }));
  const thread = useThreadShell(route?.kind === "server" ? route.threadRef : null);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const currentEnvironmentId =
    route?.kind === "server" ? route.threadRef.environmentId : primaryEnvironmentId;
  const environment = useEnvironment(currentEnvironmentId);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [controller] = useState(() => {
    const run = <W, A, E>(command: AtomCommand<W, A, E>, input: W) =>
      runAtomCommand(registry, command, input, { reportFailure: false }).then(unwrap);
    return new VoiceController({
      transport: () => new WebRtcVoiceTransport(),
      start: (environmentId, input) => run(voiceEnvironment.start, { environmentId, input }),
      end: (environmentId, sessionId) =>
        run(voiceEnvironment.end, { environmentId, input: { sessionId } }),
      execute: (environmentId, input) => run(voiceEnvironment.execute, { environmentId, input }),
      confirm: (environmentId, input) => run(voiceEnvironment.confirm, { environmentId, input }),
    });
  });
  const [open, setOpen] = useState(false);
  const openForCurrent = () => {
    const environmentId = currentEnvironmentId;
    if (environmentId)
      controller.selectTarget({
        environmentId,
        label: thread?.title ?? environment?.label ?? "Current environment",
        environmentLabel: environment?.label ?? "Current environment",
        ...(thread ? { threadId: thread.id, projectId: thread.projectId } : {}),
      });
    setOpen(true);
  };
  const openFromKeyboard = useEffectEvent(openForCurrent);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the configurable app keyboard command
  useEffect(
    () =>
      registerCommands(
        {
          "voice.open": (event) => {
            event.preventDefault();
            event.stopPropagation();
            openFromKeyboard();
          },
        },
        { keybindings: () => keybindings },
      ),
    [keybindings],
  );
  const [draftMessage, setDraftMessage] = useState<string | null>(null);
  const commitRef = useRef<((text: string) => boolean) | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- release microphone and network resources when the app host unmounts
  useEffect(
    () => () => {
      void controller.end();
    },
    [controller],
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- browser unload must release an active microphone immediately
  useEffect(() => {
    const close = () => {
      void controller.end();
    };
    window.addEventListener("pagehide", close);
    return () => window.removeEventListener("pagehide", close);
  }, [controller]);
  return (
    <VoiceContext
      value={{
        controller,
        open,
        setOpen,
        openForCurrent,
        draftMessage,
        startDictation: (target, commit) => {
          if (["live", "connecting", "finishing"].includes(controller.getSnapshot().phase)) {
            setOpen(true);
            return;
          }
          commitRef.current = commit;
          setDraftMessage(null);
          setOpen(true);
          void controller.start(target, "dictation");
        },
        finishDictation: async () => {
          const text = await controller.finishDictation();
          if (text === null) return;
          const committed = commitRef.current?.(text) ?? false;
          commitRef.current = null;
          setDraftMessage(
            committed
              ? "Added to your draft. Review it before sending."
              : "Your draft changed. Copy the transcript below to keep it.",
          );
        },
      }}
    >
      {children}
    </VoiceContext>
  );
}
export function useVoice() {
  const context = useContext(VoiceContext);
  if (!context) throw new Error("VoiceProvider is missing");
  const state = useSyncExternalStore(context.controller.subscribe, context.controller.getSnapshot);
  return { ...context, state };
}
