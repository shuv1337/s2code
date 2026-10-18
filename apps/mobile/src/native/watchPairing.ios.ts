import { requireOptionalNativeModule } from "expo";

import type { WatchCompanionStatus, WatchPairingOffer } from "./watchPairing";

type WatchPairingNativeModule = {
  getWatchCompanionStatus(): Promise<WatchCompanionStatus>;
  offerWatchPairing(
    origin: string,
    credential: string,
    mode: WatchPairingOffer["mode"],
    label: string,
  ): Promise<"paired" | "queued">;
};

function nativeModule(): WatchPairingNativeModule | null {
  return requireOptionalNativeModule<WatchPairingNativeModule>("T3NativeControls");
}

export async function getWatchCompanionStatus(): Promise<WatchCompanionStatus | null> {
  return (await nativeModule()?.getWatchCompanionStatus()) ?? null;
}

export async function offerWatchPairing(offer: WatchPairingOffer): Promise<"paired" | "queued"> {
  const module = nativeModule();
  if (!module) throw new Error("Apple Watch pairing is unavailable in this app build.");
  return module.offerWatchPairing(offer.origin, offer.credential, offer.mode, offer.label);
}
