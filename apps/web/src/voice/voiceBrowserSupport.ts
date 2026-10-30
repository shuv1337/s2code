export type VoiceBrowserSupport =
  | { readonly supported: true }
  | { readonly supported: false; readonly code: string; readonly message: string };

export function detectVoiceBrowserSupport(): VoiceBrowserSupport {
  if (!globalThis.isSecureContext)
    return {
      supported: false,
      code: "insecure-context",
      message:
        "Microphone access requires HTTPS or localhost. Open this environment through its secure address.",
    };
  if (!globalThis.navigator?.mediaDevices?.getUserMedia)
    return {
      supported: false,
      code: "media-devices-unavailable",
      message: "This browser cannot access a microphone.",
    };
  if (!globalThis.RTCPeerConnection?.prototype.createDataChannel)
    return {
      supported: false,
      code: "webrtc-unavailable",
      message:
        "This browser does not support voice calls. Use a current browser or the desktop app.",
    };
  return { supported: true };
}
