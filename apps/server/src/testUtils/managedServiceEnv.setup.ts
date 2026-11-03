import { SERVICE_LAUNCHER_CONTEXT_ENV } from "../cloud/serviceProtocol.ts";

// Agents inside a managed T3 service inherit its home and launcher context; CI has neither.
// The fork's home aliases resolve back to T3CODE_HOME, so they would reach the live userdata too.
for (const name of [
  "T3CODE_HOME",
  "S2CODE_HOME",
  "SHUV2CODE_HOME",
  "T3_BOOT_SERVICE_UNIT",
  SERVICE_LAUNCHER_CONTEXT_ENV,
]) {
  delete process.env[name];
}
