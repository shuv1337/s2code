// @effect-diagnostics nodeBuiltinImport:off -- Streams the tarball through zlib, which Effect does not wrap.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeZlib from "node:zlib";

/** npm pack's own fixed mtime, 1985-10-26T08:15:00Z. */
const FIXED_MTIME = 499_162_500;
const BLOCK = 512;
const MAX_SIZE = 8 ** 11;

const paxRecord = (key: string, value: string) => {
  const body = ` ${key}=${value}\n`;
  const length = Buffer.byteLength(body);
  let total = length + String(length).length;
  if (String(total).length !== String(length).length) total = length + String(total).length;
  return `${total}${body}`;
};

function ustarHeader(name: string, type: string, size: number, mode: number, linkname = "") {
  if (size >= MAX_SIZE) throw new Error(`${name} is too large for a ustar entry.`);
  const block = Buffer.alloc(BLOCK);
  const text = (offset: number, length: number, value: string) =>
    block.write(value, offset, length, "utf8");
  const octal = (offset: number, length: number, value: number) =>
    text(offset, length - 1, value.toString(8).padStart(length - 1, "0"));
  text(0, 100, name);
  octal(100, 8, mode);
  octal(108, 8, 0);
  octal(116, 8, 0);
  octal(124, 12, size);
  octal(136, 12, FIXED_MTIME);
  block.fill(" ", 148, 156);
  text(156, 1, type);
  text(157, 100, linkname);
  text(257, 8, "ustar\u000000");
  octal(329, 8, 0);
  octal(337, 8, 0);
  const checksum = block.reduce((sum, byte) => sum + byte, 0);
  text(148, 8, `${checksum.toString(8).padStart(6, "0")}\u0000 `);
  return block;
}

const padding = (size: number) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);

/** Paths or link targets past ustar's 100 bytes go in a pax record instead. */
function* entryHeaders(name: string, type: string, size: number, mode: number, linkname = "") {
  const records = [
    ...(Buffer.byteLength(name) > 100 ? [paxRecord("path", name)] : []),
    ...(Buffer.byteLength(linkname) > 100 ? [paxRecord("linkpath", linkname)] : []),
  ].join("");
  if (records) {
    const pax = Buffer.from(records);
    yield ustarHeader("././@PaxHeader", "x", pax.length, 0o644);
    yield pax;
    yield padding(pax.length);
  }
  yield ustarHeader(name, type, size, mode, linkname);
}

async function* entries(root: string, relative: string): AsyncGenerator<Buffer> {
  const file = NodePath.join(root, relative);
  const name = relative.split(NodePath.sep).join("/");
  const stat = await NodeFS.promises.lstat(file);
  if (stat.isDirectory()) {
    yield* entryHeaders(`${name}/`, "5", 0, 0o755);
    for (const child of (await NodeFS.promises.readdir(file)).sort())
      yield* entries(root, NodePath.join(relative, child));
  } else if (stat.isSymbolicLink()) {
    yield* entryHeaders(name, "2", 0, 0o777, await NodeFS.promises.readlink(file));
  } else if (stat.isFile()) {
    yield* entryHeaders(name, "0", stat.size, stat.mode & 0o111 ? 0o755 : 0o644);
    for await (const chunk of NodeFS.createReadStream(file)) yield chunk as Buffer;
    yield padding(stat.size);
  } else {
    throw new Error(`Cannot pack ${name}: not a file, directory or symlink.`);
  }
}

/**
 * Packs `root/entry` so the bytes depend only on names, contents, executable bits
 * and link targets, never on readdir order, mtimes, ownership, umask or host tar.
 * zlib's output is fixed per Node version, which package.json pins exactly.
 */
export async function packDeterministicTarball(root: string, entry: string, tarball: string) {
  async function* archive() {
    yield* entries(root, entry);
    yield Buffer.alloc(BLOCK * 2);
  }
  await NodeStreamPromises.pipeline(
    NodeStream.Readable.from(archive()),
    NodeZlib.createGzip(),
    NodeFS.createWriteStream(tarball),
  );
}
