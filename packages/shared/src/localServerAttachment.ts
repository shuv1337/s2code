import * as Schema from "effect/Schema";

// Private, process-lifetime discovery record in the selected server state directory.
// This is deliberately separate from the public server-runtime.json metadata.
export const LOCAL_SERVER_ATTACHMENT_FILE = "desktop-attachment.json";
export const LocalServerAttachment = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  port: Schema.Int,
  serverVersion: Schema.String,
  bootstrapSecret: Schema.String,
});
export type LocalServerAttachment = typeof LocalServerAttachment.Type;

export function isLocalServerAttachmentCompatible(
  record: LocalServerAttachment,
  appVersion: string,
): boolean {
  // A packaged renderer and V2 server evolve together, including nightly builds.
  return (
    record.serverVersion === appVersion &&
    record.pid > 0 &&
    record.port > 0 &&
    record.port <= 65535 &&
    /^[a-f0-9]{64}$/i.test(record.bootstrapSecret)
  );
}
