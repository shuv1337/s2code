import Foundation

/// Millisecond-precision UTC timestamps in the `DateTimeUtcFromString` wire form
/// (`2026-10-11T23:25:40.084Z`). Formatting is deterministic so a persisted envelope re-encodes
/// to the same bytes; the server fingerprints `notAfter` at millisecond precision.
public enum WatchTimestamp {
  public static func truncatedToMilliseconds(_ date: Date) -> Date {
    Date(timeIntervalSince1970: Double(milliseconds(date)) / 1000)
  }

  public static func format(_ date: Date) -> String {
    let ms = milliseconds(date)
    let seconds = ms.floorDivided(by: 1000)
    let fraction = ms - seconds * 1000
    let components = utcCalendar.dateComponents(
      [.year, .month, .day, .hour, .minute, .second],
      from: Date(timeIntervalSince1970: Double(seconds))
    )
    return String(
      format: "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
      components.year ?? 0, components.month ?? 0, components.day ?? 0,
      components.hour ?? 0, components.minute ?? 0, components.second ?? 0, fraction
    )
  }

  public static func parse(_ string: String) -> Date? {
    let withFraction = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    let plain = Date.ISO8601FormatStyle()
    guard let date = (try? withFraction.parse(string)) ?? (try? plain.parse(string)) else {
      return nil
    }
    return truncatedToMilliseconds(date)
  }

  private static func milliseconds(_ date: Date) -> Int64 {
    Int64((date.timeIntervalSince1970 * 1000).rounded())
  }

  private static let utcCalendar: Calendar = {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    return calendar
  }()
}

private extension Int64 {
  func floorDivided(by divisor: Int64) -> Int64 {
    let quotient = self / divisor
    return (self % divisor != 0 && (self < 0) != (divisor < 0)) ? quotient - 1 : quotient
  }
}

extension JSONDecoder {
  static var watch: JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { decoder in
      let container = try decoder.singleValueContainer()
      let string = try container.decode(String.self)
      guard let date = WatchTimestamp.parse(string) else {
        throw DecodingError.dataCorruptedError(
          in: container, debugDescription: "Invalid ISO-8601 timestamp: \(string)")
      }
      return date
    }
    return decoder
  }
}

extension JSONEncoder {
  static var watch: JSONEncoder {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    encoder.dateEncodingStrategy = .custom { date, encoder in
      var container = encoder.singleValueContainer()
      try container.encode(WatchTimestamp.format(date))
    }
    return encoder
  }
}
