import XCTest
@testable import Runna

final class FormattingTests: XCTestCase {
    func testArea() {
        XCTAssertEqual(Format.area(25_000), "25.000 m²")
        XCTAssertEqual(Format.area(1_250_000), "1,25 km²")
        XCTAssertEqual(Format.area(50_000), "0,05 km²")
    }

    func testDistanceAndDuration() {
        XCTAssertEqual(Format.distance(800), "800 m")
        XCTAssertEqual(Format.distance(1_500), "1,50 km")
        XCTAssertEqual(Format.duration(65), "01:05")
        XCTAssertEqual(Format.duration(3_723), "1:02:03")
    }

    func testPace() {
        XCTAssertEqual(Format.pace(distanceMeters: 1_000, seconds: 312), "5:12 /km")
        XCTAssertEqual(Format.pace(distanceMeters: 10, seconds: 312), "--")
    }
}

final class WidgetSnapshotTests: XCTestCase {
    func testTexts() {
        XCTAssertEqual(RunnaWidgetSnapshot.areaText(1_250_000), "1,25 km²")
        XCTAssertEqual(RunnaWidgetSnapshot.areaText(34_000), "34.000 m²")
        XCTAssertEqual(RunnaWidgetSnapshot.distanceText(12_400), "12,4 km")
    }

    func testWeekStartsOnMondayInSpain() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(identifier: "Europe/Madrid"))
        // Wednesday 29 October 2025, 18:00 in Madrid
        let wednesday = try XCTUnwrap(calendar.date(from: DateComponents(year: 2025, month: 10, day: 29, hour: 18)))
        let start = RunnaWidgetSnapshot.weekStart(of: wednesday)
        let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute, .weekday], from: start)
        XCTAssertEqual(parts.day, 27)
        XCTAssertEqual(parts.hour, 0)
        XCTAssertEqual(parts.weekday, 2) // Monday

        var snapshot = RunnaWidgetSnapshot(name: "Yo", colorHex: "#00FF00", totalArea: 0)
        snapshot.weekStart = start
        XCTAssertTrue(snapshot.isCurrentWeek(at: wednesday))
        XCTAssertFalse(snapshot.isCurrentWeek(at: wednesday.addingTimeInterval(7 * 24 * 3600)))
    }
}
