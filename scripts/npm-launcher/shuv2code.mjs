#!/usr/bin/env node
// Downloads this package version's CLI archive from the GitHub Release, checks it against the
// sha256 manifest published inside this package, caches it, and runs it.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const packageDir = path.join(import.meta.dirname, "..");
const { version } = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
// { [platform-arch]: { archive, sha256 } }, written at build time from the release's archives.
const checksums = JSON.parse(fs.readFileSync(path.join(packageDir, "checksums.json"), "utf8"));
const RELEASES = "https://github.com/shuv1337/s2code/releases";

function cacheRoot() {
  if (process.platform === "win32")
    return process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches");
  return process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
}

async function download(url, file) {
  const response = await fetch(url).catch((error) => {
    throw new Error(`GET ${url} failed: ${error.cause?.message ?? error.message}`);
  });
  if (response.status === 404) {
    throw new Error(
      `${url} does not exist yet. If ${version} was just released, try again in a few minutes.`,
    );
  }
  if (!response.ok) throw new Error(`GET ${url} returned HTTP ${response.status}`);
  const total = Number(response.headers.get("content-length")) || 0;
  const hash = crypto.createHash("sha256");
  const out = fs.openSync(file, "w");
  const tty = process.stderr.isTTY;
  let received = 0;
  let shown = -1;
  try {
    for await (const chunk of response.body) {
      hash.update(chunk);
      fs.writeSync(out, chunk);
      received += chunk.byteLength;
      // Redraw once per percent (or per MB without a length), not per chunk.
      const step = total ? Math.floor((received * 100) / total) : Math.floor(received / 1048576);
      if (tty && step !== shown) {
        shown = step;
        const percent = total ? ` ${step}%` : "";
        process.stderr.write(
          `\r\x1b[2Kshuv2code: downloading S2Code ${version}${percent} (${(received / 1048576).toFixed(1)} MB)`,
        );
      }
    }
  } finally {
    fs.closeSync(out);
    if (tty) process.stderr.write("\r\x1b[2K");
  }
  return hash.digest("hex");
}

async function install(dir, key) {
  const { archive, sha256: expected } = checksums[key];
  const base = (process.env.S2CODE_RELEASE_BASE_URL || `${RELEASES}/download`).replace(/\/+$/, "");

  // Stage beside the destination and rename atomically to avoid half-installed versions.
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const staging = fs.mkdtempSync(`${dir}.staging-`);
  try {
    const file = path.join(staging, archive);
    const actual = await download(`${base}/v${version}/${archive}`, file);
    if (actual !== expected) {
      throw new Error(
        `checksum mismatch for ${archive}: expected sha256 ${expected}, downloaded ${actual}. Nothing was installed.`,
      );
    }
    // Windows' own tar.exe reads zip; a Git-for-Windows tar on PATH cannot.
    const tar =
      process.platform === "win32" ? `${process.env.SystemRoot}\\System32\\tar.exe` : "tar";
    const extract = spawnSync(tar, ["-xf", file, "-C", staging, "--strip-components=1"], {
      stdio: "inherit",
    });
    if (extract.status !== 0) throw new Error(`could not extract ${archive}`);
    fs.rmSync(file);
    const validate = spawnSync(
      path.join(staging, process.platform === "win32" ? "t3.exe" : "t3"),
      ["--version"],
      {
        stdio: ["ignore", "ignore", "pipe"],
        encoding: "utf8",
        timeout: 30_000,
        killSignal: "SIGKILL",
      },
    );
    if (validate.status !== 0) {
      throw executableError(
        key,
        validate.error?.message ||
          validate.stderr?.trim() ||
          `--version exited with ${validate.signal || validate.status}`,
      );
    }
    fs.writeFileSync(path.join(staging, ".install-complete"), `${version}\n`);
    publish(staging, dir);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

const isComplete = (dir) => {
  try {
    return fs.readFileSync(path.join(dir, ".install-complete"), "utf8").trim() === version;
  } catch {
    return false;
  }
};

/** Preserve concurrently published complete installs; replace only incomplete folders without the completion marker. */
function publish(staging, dir) {
  try {
    fs.renameSync(staging, dir);
    return;
  } catch (error) {
    if (isComplete(dir)) return;
    if (!fs.existsSync(dir)) throw error;
  }
  const lock = `${dir}.lock`;
  try {
    fs.mkdirSync(lock);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error(
      `another shuv2code is installing ${version}. If none is running, delete ${lock} and try again.`,
      { cause: error },
    );
  }
  const stale = `${staging}.stale`;
  try {
    // A peer may have published between our marker check and taking the lock.
    if (isComplete(dir)) return;
    // Move it aside rather than deleting in place: once the folder is empty, a
    // peer's first rename can land in it.
    fs.renameSync(dir, stale);
    try {
      fs.renameSync(staging, dir);
    } catch (error) {
      if (!isComplete(dir)) throw error;
    }
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
    fs.rmSync(stale, { recursive: true, force: true });
  }
}

async function main() {
  const key = `${process.platform}-${process.arch}`;
  if (!Object.hasOwn(checksums, key)) {
    throw new Error(
      `${key} is not supported. The CLI is built for ${Object.keys(checksums).join(", ")}.\n` +
        `The desktop app and release archives are at ${RELEASES}`,
    );
  }
  const dir = path.join(cacheRoot(), "s2code", "runtime", version);
  if (!isComplete(dir)) await install(dir, key);

  // Service IPC and signals must reach the child; terminal Ctrl-C already does, so do not forward SIGINT twice.
  const ipc = process.send !== undefined;
  const child = spawn(
    path.join(dir, process.platform === "win32" ? "t3.exe" : "t3"),
    process.argv.slice(2),
    {
      stdio: ipc ? ["inherit", "inherit", "inherit", "ipc"] : "inherit",
      // The executable lives in the cache, so this is how it knows npm launched it.
      env: { ...process.env, T3CODE_NPM_LAUNCHER_PATH: import.meta.filename },
    },
  );
  if (ipc) {
    process.on("message", (message) => child.connected && child.send(message));
    child.on("message", (message) => process.connected && process.send(message));
    process.on("disconnect", () => child.connected && child.disconnect());
  }
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => (ipc || signal !== "SIGINT") && child.kill(signal));
  }
  child.on("error", (error) => fail(executableError(key, error.message)));
  child.on("exit", (code, signal) =>
    process.exit(code ?? 128 + (os.constants.signals[signal] || 1)),
  );
}

function executableError(key, detail) {
  return new Error(
    `could not run S2Code ${version} for ${key}: ${detail}` +
      (process.platform === "linux"
        ? "\nThe Linux release requires glibc; musl-based systems such as Alpine are not supported. Use a glibc-based Linux environment."
        : ""),
  );
}

function fail(error) {
  process.stderr.write(`shuv2code: ${error.message}\n`);
  process.exit(1);
}

await main().catch(fail);
