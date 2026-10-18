export type WatchCompanionStatus = {
  readonly isPaired: boolean;
  readonly isWatchAppInstalled: boolean;
  readonly phoneLabel: string;
};

export type WatchPairingOffer = {
  readonly origin: string;
  readonly credential: string;
  readonly mode: "automatic" | "phone";
  readonly label: string;
};

export async function getWatchCompanionStatus(): Promise<WatchCompanionStatus | null> {
  return null;
}

export async function offerWatchPairing(_offer: WatchPairingOffer): Promise<"paired" | "queued"> {
  throw new Error("Apple Watch pairing is only available on iPhone.");
}
