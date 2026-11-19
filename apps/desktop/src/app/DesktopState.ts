import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { BackendStartupFailure } from "../backend/DesktopBackendManager.ts";

/** Startup health of the primary local backend, read by the startup recovery window. */
export type PrimaryBackendStartup =
  | { readonly _tag: "Starting" }
  | { readonly _tag: "Ready" }
  | ({ readonly _tag: "Failing" } & BackendStartupFailure);

export class DesktopState extends Context.Service<
  DesktopState,
  {
    readonly backendReady: Ref.Ref<boolean>;
    readonly quitting: Ref.Ref<boolean>;
    // First signal received while another flow (update install, relaunch) holds `quitting`
    // without going through before-quit. Scoped to one `quitting` hold: whoever resets
    // `quitting` to false must also clear this, or a later hold inherits a stale timestamp.
    readonly externalQuitSignalSinceNanos: Ref.Ref<bigint | null>;
    // Set by DesktopUpdates.configure, which runs before the first backend start.
    readonly canInstallUpdates: Ref.Ref<boolean>;
    readonly primaryBackendStartup: SubscriptionRef.SubscriptionRef<PrimaryBackendStartup>;
  }
>()("@t3tools/desktop/app/DesktopState") {}

const make = Effect.all({
  backendReady: Ref.make(false),
  quitting: Ref.make(false),
  externalQuitSignalSinceNanos: Ref.make<bigint | null>(null),
  canInstallUpdates: Ref.make(false),
  primaryBackendStartup: SubscriptionRef.make<PrimaryBackendStartup>({ _tag: "Starting" }),
});

export const layer = Layer.effect(DesktopState, make);
