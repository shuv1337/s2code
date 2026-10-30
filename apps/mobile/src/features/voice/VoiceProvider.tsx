import { RegistryContext } from "@effect/atom-react";
import { VoiceController, type VoiceTarget } from "@t3tools/client-runtime/voice/controller";
import { createVoiceEnvironmentAtoms } from "@t3tools/client-runtime/state/voice";
import {
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { AppState } from "react-native";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useGlobalVoiceInput } from "../voice-input/VoiceInputProvider";
import { NativeVoiceTransport } from "./NativeVoiceTransport";

export const voiceEnvironment = createVoiceEnvironmentAtoms(connectionAtomRuntime);
const Context = createContext<{
  controller: VoiceController;
  open: boolean;
  setOpen: (open: boolean) => void;
  startCall: (target: VoiceTarget) => void;
  startDictation: (target: VoiceTarget, commit: (text: string) => boolean) => void;
  finishDictation: () => Promise<void>;
  draftMessage: string | null;
} | null>(null);
export function VoiceProvider({ children }: { children: ReactNode }) {
  const registry = useContext(RegistryContext);
  const localVoice = useGlobalVoiceInput();
  const [controller] = useState(() => {
    const run = async <W, A, E>(command: AtomCommand<W, A, E>, input: W) => {
      const result = await runAtomCommand(registry, command, input, { reportFailure: false });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      return result.value;
    };
    return new VoiceController({
      transport: () => new NativeVoiceTransport(),
      start: (environmentId, input) => run(voiceEnvironment.start, { environmentId, input }),
      end: (environmentId, sessionId) =>
        run(voiceEnvironment.end, { environmentId, input: { sessionId } }),
      execute: (environmentId, input) => run(voiceEnvironment.execute, { environmentId, input }),
      confirm: (environmentId, input) => run(voiceEnvironment.confirm, { environmentId, input }),
    });
  });
  const [open, setOpen] = useState(false);
  const [draftMessage, setDraftMessage] = useState<string | null>(null);
  const commitRef = useRef<((text: string) => boolean) | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- native audio must stop when the app backgrounds or its host unmounts
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (
        state === "background" ||
        (state === "inactive" && controller.getSnapshot().phase === "live")
      )
        void controller.end();
    });
    return () => {
      subscription.remove();
      void controller.end();
    };
  }, [controller]);
  const start = async (target: VoiceTarget, mode: "call" | "dictation") => {
    setOpen(true);
    if (["connecting", "live", "finishing"].includes(controller.getSnapshot().phase)) return;
    await localVoice.cancel();
    await controller.start(target, mode);
  };
  return (
    <Context
      value={{
        controller,
        open,
        setOpen,
        draftMessage,
        startCall: (target) => {
          void start(target, "call");
        },
        startDictation: (target, commit) => {
          if (["live", "connecting", "finishing"].includes(controller.getSnapshot().phase)) {
            setOpen(true);
            return;
          }
          commitRef.current = commit;
          setDraftMessage(null);
          void start(target, "dictation");
        },
        finishDictation: async () => {
          const text = await controller.finishDictation();
          if (text === null) return;
          const committed = commitRef.current?.(text) ?? false;
          commitRef.current = null;
          setDraftMessage(
            committed
              ? "Added to your draft. Review it before sending."
              : "Your draft changed. Copy the transcript to keep it.",
          );
        },
      }}
    >
      {children}
    </Context>
  );
}
export function useVoice() {
  const context = useContext(Context);
  if (!context) throw new Error("VoiceProvider is missing");
  const state = useSyncExternalStore(context.controller.subscribe, context.controller.getSnapshot);
  return { ...context, state };
}
