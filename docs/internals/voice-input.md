# Voice input

Transcription edits a composer draft. It does not submit an agent turn. Audio is
temporary client input, and only normal message submission sends the resulting
text. The iPhone implementation transcribes locally on supported iOS devices. Watch
recordings use the environment's [local transcription service](../../apps/server/src/transcription/LocalTranscription.ts)
on macOS and Linux. Transcription does not dispatch a message: the Watch submits
reviewed text through its existing admission and receipt path.

The server keeps one CPU recognizer and admits one transcription at a time. Native
recognition is asynchronous but cannot be cancelled; its concurrency permit stays
held until decoding settles, even if the HTTP client disconnects. Otherwise a
retry could overlap a still-running native decode. Model assets are pinned and
verified before loading, and request audio is removed when the request scope ends.

The [shared controller](../../packages/client-runtime/src/voice-input/controller.ts)
owns the operation while the client supplies capture and transcription. Preparation
binds the transcriber and resolved locale for the whole recording. Draft ownership,
text, and revision are captured before recording and checked before insertion, so
a late transcript cannot overwrite a draft that was edited or replaced.

Cancellation invalidates a result immediately, but resources stay owned until the
underlying work settles. Apple's native transcription call cannot be interrupted
once started. Releasing the session or deleting its recording when the abort signal
fires would race that work. The [transcription contract](../../packages/client-runtime/src/voice-input/transcription.ts)
therefore requires implementations to settle only after their work has stopped;
the [Apple binding](../../apps/mobile/src/native/voiceTranscription.ios.ts) checks
cancellation between native calls and discards late results.
