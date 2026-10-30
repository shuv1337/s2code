import type { VoiceTransport } from "@t3tools/client-runtime/voice/controller";
import type { MediaStream, RTCPeerConnection } from "react-native-webrtc";
import {
  acquireAudioSession,
  activateAudioSession,
  releaseAudioSession,
} from "../../lib/audioSession";

export class NativeVoiceTransport implements VoiceTransport {
  #peer: RTCPeerConnection | null = null;
  #stream: MediaStream | null = null;
  #channel: ReturnType<RTCPeerConnection["createDataChannel"]> | null = null;
  #audio: ReturnType<typeof acquireAudioSession> | null = null;
  #closed = false;
  #abort: (() => void) | null = null;
  async connect(input: Parameters<VoiceTransport["connect"]>[0]) {
    try {
      const rtc = await import("react-native-webrtc");
      if (this.#closed) return;
      this.#audio = acquireAudioSession("recording", input.onMicrophoneEnded);
      if (!(await activateAudioSession(this.#audio)) || this.#closed) return;
      const stream = await rtc.mediaDevices.getUserMedia({ audio: true, video: false });
      if (this.#closed) {
        for (const track of stream.getTracks()) track.stop();
        stream.release();
        return;
      }
      this.#stream = stream;
      const peer = new rtc.RTCPeerConnection({});
      this.#peer = peer;
      for (const track of stream.getAudioTracks()) {
        peer.addTrack(track, stream);
        track.addEventListener("ended", () => {
          if (!this.#closed) input.onMicrophoneEnded();
        });
      }
      const channel = peer.createDataChannel("oai-events");
      this.#channel = channel;
      channel.addEventListener("message", (event) => {
        if (!this.#closed && typeof event.data === "string") input.onData(event.data);
      });
      peer.addEventListener("connectionstatechange", () => {
        if (!this.#closed) input.onConnectionStateChange(peer.connectionState);
      });
      peer.addEventListener("track", (event) => {
        if (!input.playRemoteAudio && event.track) event.track.enabled = false;
      });
      await peer.setLocalDescription(await peer.createOffer({}));
      if (peer.iceGatheringState !== "complete")
        await new Promise<void>((resolve, reject) => {
          const settle = (error?: Error) => {
            clearTimeout(timer);
            peer.removeEventListener("icegatheringstatechange", onIce);
            this.#abort = null;
            if (error) reject(error);
            else resolve();
          };
          const onIce = () => {
            if (peer.iceGatheringState === "complete") settle();
          };
          const timer = setTimeout(
            () =>
              settle(new Error("Could not prepare voice audio. Check your connection and retry.")),
            10000,
          );
          this.#abort = () => settle(new Error("Voice ended."));
          peer.addEventListener("icegatheringstatechange", onIce);
          if (this.#closed) this.#abort();
          else onIce();
        });
      if (this.#closed) return;
      const sdp = peer.localDescription?.sdp;
      if (!sdp) throw new Error("Could not prepare the microphone connection.");
      const answer = await input.exchangeOffer(sdp);
      if (!this.#closed) await peer.setRemoteDescription({ type: "answer", sdp: answer });
    } catch (error) {
      this.close();
      throw error;
    }
  }
  send(event: Record<string, unknown>) {
    if (this.#channel?.readyState === "open") this.#channel.send(JSON.stringify(event));
  }
  setMuted(muted: boolean) {
    for (const track of this.#stream?.getAudioTracks() ?? []) track.enabled = !muted;
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#abort?.();
    this.#abort = null;
    this.#channel?.close();
    this.#channel = null;
    this.#peer?.close();
    this.#peer = null;
    for (const track of this.#stream?.getTracks() ?? []) track.stop();
    this.#stream?.release();
    this.#stream = null;
    if (this.#audio) void releaseAudioSession(this.#audio);
    this.#audio = null;
  }
}
