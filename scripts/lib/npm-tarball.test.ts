import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { packDeterministicTarball } from "./npm-tarball.ts";

const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const run = Effect.fn("test.run")(function* (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string },
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(ChildProcess.make(command, args, { cwd: options.cwd }));
  const [stderr, exitCode] = yield* Effect.all(
    [collect(child.stderr), child.exitCode.pipe(Effect.map(Number))],
    { concurrency: "unbounded" },
  );
  return { stderr, exitCode };
});

it.layer(NodeServices.layer)("npm-tarball", (it) => {
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "packs the same tree to identical bytes whatever its mtimes, modes and creation order",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-npm-tarball-test-" });
        const deep = `node_modules/${"long-scoped-directory-name/".repeat(5)}index.js`;
        const files = [
          { name: "t3", content: "#!/bin/sh\n", modes: [0o755, 0o700] },
          { name: "README.md", content: "# readme\n", modes: [0o644, 0o600] },
          { name: deep, content: "module.exports = 1;\n", modes: [0o644, 0o664] },
        ];
        const pack = Effect.fn("test.pack")(function* (variant: 0 | 1) {
          const stage = path.join(root, `stage-${variant}`);
          for (const file of variant === 0 ? files : files.toReversed()) {
            const target = path.join(stage, "package", file.name);
            yield* fs.makeDirectory(path.dirname(target), { recursive: true });
            yield* fs.writeFileString(target, file.content);
            yield* fs.chmod(target, file.modes[variant]!);
          }
          yield* fs.symlink("t3", path.join(stage, "package/t3-link"));
          const stamp = variant === 0 ? 981_173_106 : 1_793_664_000;
          for (const entry of yield* fs.readDirectory(stage, { recursive: true }))
            if (!entry.endsWith("t3-link")) yield* fs.utimes(path.join(stage, entry), stamp, stamp);
          const tarball = path.join(root, `package-${variant}.tgz`);
          yield* Effect.promise(() => packDeterministicTarball(stage, "package", tarball));
          return Buffer.from(yield* fs.readFile(tarball));
        });
        const first = yield* pack(0);
        assert.isTrue(first.equals(yield* pack(1)));

        // The host tar reads it back, pax long paths and executable bit included.
        const unpacked = path.join(root, "unpacked");
        yield* fs.makeDirectory(unpacked);
        const extract = yield* run("tar", ["-xzf", path.join(root, "package-0.tgz")], {
          cwd: unpacked,
        });
        assert.equal(extract.exitCode, 0, extract.stderr);
        assert.equal(
          yield* fs.readFileString(path.join(unpacked, "package", deep)),
          "module.exports = 1;\n",
        );
        assert.equal(
          Number((yield* fs.stat(path.join(unpacked, "package/t3"))).mode) & 0o777,
          0o755,
        );
        assert.equal(yield* fs.readLink(path.join(unpacked, "package/t3-link")), "t3");
      }),
  );
});
