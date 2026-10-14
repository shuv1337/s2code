import { ORCHESTRATION_PROTOCOL_HEADER } from "@t3tools/contracts";

export const browserApiCorsAllowedMethods = ["GET", "POST", "OPTIONS"] as const;
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
  "dpop",
  ORCHESTRATION_PROTOCOL_HEADER,
] as const;

/** Origins of the Electron renderer, packaged and dev. */
export const DESKTOP_RENDERER_ORIGINS = [
  "t3code://app",
  "t3code-dev://app",
  "shuv2code://app",
  "shuv2code-dev://app",
  "shuv2code-nightly://app",
  "shuv2code-preview://app",
] as const;
