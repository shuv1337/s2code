import { expect, it } from "vite-plus/test";

import { redactVoiceLogText } from "./logRedaction.ts";

it("redacts SDP session descriptions and ICE or fingerprint lines", () => {
  expect(redactVoiceLogText("v=0\r\na=ice-pwd:secret-pwd\r\n", 200)).toBe("[redacted]");
  expect(redactVoiceLogText("a=ice-pwd:secret-pwd", 200)).toBe("[redacted]");
  expect(redactVoiceLogText("a=ice-ufrag:secret-ufrag", 200)).toBe("[redacted]");
  expect(redactVoiceLogText("a=fingerprint:sha-256 AA:BB", 200)).toBe("[redacted]");
  expect(redactVoiceLogText("hello\na=ice-pwd:secret-pwd\nworld", 200)).toBe(
    "hello\n[redacted]\nworld",
  );
  expect(redactVoiceLogText("thread sk-abcdefghijklmnopqrstuvwxyz", 200)).toBe("thread [redacted]");
});
