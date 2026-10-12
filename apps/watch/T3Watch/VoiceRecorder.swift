import AVFoundation
import Observation
import T3WatchKit

/// Direct AAC capture, following GrokWatch's recorder. Never opens system dictation.
@MainActor @Observable
final class VoiceRecorder: NSObject, AVAudioRecorderDelegate {
  private(set) var isRecording = false
  private(set) var isStarting = false
  private(set) var elapsed: TimeInterval = 0
  private(set) var level: Double = 0
  private(set) var fileURL: URL?
  private(set) var error: String?
  private var recorder: AVAudioRecorder?
  private var meter: Task<Void, Never>?
  private var interruption: NSObjectProtocol?
  private var generation = 0

  func restore(draftId: UUID) {
    guard fileURL == nil, let url = try? recordingURL(draftId: draftId),
      FileManager.default.fileExists(atPath: url.path)
    else { return }
    fileURL = url
  }

  private func recordingURL(draftId: UUID) throws -> URL {
    let directory = try WatchStorage.directory().appendingPathComponent(
      "Recordings", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory.appendingPathComponent(draftId.uuidString + ".m4a")
  }

  func start(draftId: UUID) async {
    guard !isRecording, !isStarting else { return }
    isStarting = true
    generation += 1
    let attempt = generation
    defer { isStarting = false }
    error = nil
    let permitted = await AVAudioApplication.requestRecordPermission()
    guard generation == attempt else { return }
    guard permitted else {
      error = "Allow microphone access in Settings to record."
      return
    }
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(.record, mode: .default)
      try session.setActive(true)
      let url = try recordingURL(draftId: draftId)
      let audio = try AVAudioRecorder(
        url: url,
        settings: [
          AVFormatIDKey: kAudioFormatMPEG4AAC,
          AVSampleRateKey: 24_000,
          AVNumberOfChannelsKey: 1,
          AVEncoderBitRateKey: 48_000,
          AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
        ])
      audio.delegate = self
      audio.isMeteringEnabled = true
      guard audio.prepareToRecord(), audio.record(forDuration: 120) else {
        try? FileManager.default.removeItem(at: url)
        throw CocoaError(.fileWriteUnknown)
      }
      if let old = fileURL, old != url { try? FileManager.default.removeItem(at: old) }
      fileURL = url
      recorder = audio
      isRecording = true
      interruption = NotificationCenter.default.addObserver(
        forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
      ) { [weak self] note in
        let began =
          (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt)
          == AVAudioSession.InterruptionType.began.rawValue
        if began { Task { @MainActor in self?.stop() } }
      }
      elapsed = 0
      meter = Task { [weak self] in
        while !Task.isCancelled {
          try? await Task.sleep(for: .milliseconds(150))
          guard let self, self.isRecording, !Task.isCancelled else { return }
          audio.updateMeters()
          self.elapsed = audio.currentTime
          self.level = min(1, max(0, (Double(audio.averagePower(forChannel: 0)) + 55) / 55))
        }
      }
    } catch {
      try? session.setActive(false)
      self.error = "The microphone could not start. Try again."
    }
  }

  /// Wrist-down and interruptions stop capture but never send an instruction.
  func stop() {
    generation += 1
    guard isRecording else { return }
    elapsed = recorder?.currentTime ?? elapsed
    isRecording = false
    meter?.cancel()
    if let interruption { NotificationCenter.default.removeObserver(interruption) }
    interruption = nil
    recorder?.stop()
    recorder = nil
    level = 0
    try? AVAudioSession.sharedInstance().setActive(false)
  }

  func discard() {
    stop()
    if let fileURL { try? FileManager.default.removeItem(at: fileURL) }
    fileURL = nil
    elapsed = 0
  }

  nonisolated func audioRecorderDidFinishRecording(
    _ recorder: AVAudioRecorder, successfully flag: Bool
  ) {
    Task { @MainActor in self.stop() }
  }

  nonisolated func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
    Task { @MainActor in
      self.stop()
      self.error = "Recording was interrupted. Try recording again."
    }
  }
}
