import { expect, it, vi } from "vite-plus/test";
import { WebRtcVoiceTransport } from "./WebRtcVoiceTransport";

it("releases a microphone granted after End without creating a connection", async () => {
  let grant!: (stream: MediaStream) => void;
  const permission = new Promise<MediaStream>((resolve) => {
    grant = resolve;
  });
  const stop = vi.fn();
  const createPeerConnection = vi.fn<() => RTCPeerConnection>();
  const exchangeOffer = vi.fn(async () => "answer");
  const transport = new WebRtcVoiceTransport({
    getUserMedia: () => permission,
    createPeerConnection,
    createAudioElement: vi.fn<() => HTMLAudioElement>(),
  });
  const connecting = transport.connect({ exchangeOffer, onData: () => {} });
  transport.close();
  grant({ getTracks: () => [{ stop }] } as unknown as MediaStream);
  await connecting;
  expect(stop).toHaveBeenCalledOnce();
  expect(createPeerConnection).not.toHaveBeenCalled();
  expect(exchangeOffer).not.toHaveBeenCalled();
});

it("mutes the capture track and tears down playback, tracks and the data channel on End", async () => {
  const track = { enabled: true, stop: vi.fn(), addEventListener: vi.fn() };
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  const channel = { readyState: "open", send: vi.fn(), close: vi.fn(), addEventListener: vi.fn() };
  const peer = {
    createDataChannel: () => channel,
    addTrack: vi.fn(),
    addEventListener: vi.fn(),
    createOffer: async () => ({ type: "offer", sdp: "offer" }),
    setLocalDescription: async () => {},
    localDescription: { sdp: "offer" },
    iceGatheringState: "complete",
    setRemoteDescription: vi.fn(async () => {}),
    close: vi.fn(),
  };
  const audio = {
    autoplay: false,
    setAttribute: vi.fn(),
    style: {},
    pause: vi.fn(),
    srcObject: stream as MediaStream | null,
    removeAttribute: vi.fn(),
  };
  const transport = new WebRtcVoiceTransport({
    getUserMedia: async () => stream,
    createPeerConnection: () => peer as unknown as RTCPeerConnection,
    createAudioElement: () => audio as unknown as HTMLAudioElement,
  });
  await transport.connect({ exchangeOffer: async () => "answer", onData: () => {} });
  expect(peer.setRemoteDescription).toHaveBeenCalledWith({ type: "answer", sdp: "answer" });
  transport.setMuted(true);
  expect(track.enabled).toBe(false);
  transport.setMuted(false);
  expect(track.enabled).toBe(true);
  transport.close();
  transport.close();
  expect(track.stop).toHaveBeenCalledOnce();
  expect(channel.close).toHaveBeenCalledOnce();
  expect(peer.close).toHaveBeenCalledOnce();
  expect(audio.pause).toHaveBeenCalledOnce();
  expect(audio.srcObject).toBeNull();
});
