# Watch transcription

Watch recordings are transcribed on the connected T3 server using sherpa-onnx and
Parakeet TDT 0.6B v2 (int8, English). macOS arm64 and Linux x64 use the same CPU
path. Neither an Apple speech framework nor an API key is required. Threads on
other environments use those environments' servers.

The first recording downloads about 661 MB of model assets into
`<T3 home>/userdata/speech-models/`. Allow up to ten minutes for preparation and
keep at least 1.5 GB of disk space available. Downloads come from a pinned revision
of the sherpa-onnx model maintainer's Hugging Face repository and are checked
against fixed SHA-256 hashes. Once cached, transcription works without internet
access. An interrupted download can be retried; completed files are reused.

Audio stays on the server. The server accepts AAC recordings up to two minutes and
1 MiB, decodes them using the bundled FFmpeg, and removes temporary audio when the
request finishes. A transcript is returned to the Watch for review; transcription
alone never sends or steers a thread. One recording is processed at a time, with
two CPU inference threads. A busy response leaves the recording on the Watch for
retry.

For a source install, use the repository's normal dependency installation. The
`ffmpeg-static` install script must be allowed; `pnpm-workspace.yaml` grants it.
Packaged installations must retain `sherpa-onnx-node`, the target's matching native
package, and `ffmpeg-static` with its target-specific executable. They are runtime
externals in the shared CLI packaging list. Do not copy a Mac `node_modules` tree
to Linux.

If model preparation fails, check outbound access to Hugging Face and the server's
free disk space. If transcription is unavailable, check that the platform's
native packages and FFmpeg executable were included. No system dictation fallback
is used.

Model: [sherpa-onnx Parakeet v2 export](https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8),
CC-BY-4.0; based on NVIDIA Parakeet. Runtime:
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), Apache-2.0.
[FFmpeg static distribution](https://github.com/eugeneware/ffmpeg-static) is
GPL-3.0-or-later and retains its upstream license with the installed package.
