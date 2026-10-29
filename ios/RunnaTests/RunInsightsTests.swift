import XCTest
import CoreLocation
@testable import Runna

final class RunGeometryTests: XCTestCase {
    func testAreaOfSquare() {
        let ring = TestTracks.square(side: 100)
        XCTAssertEqual(RunGeometry.area(of: ring), 10_000, accuracy: 300)
    }

    func testContains() {
        let ring = TestTracks.square(side: 100)
        XCTAssertTrue(RunGeometry.contains(ring, TestTracks.point(east: 50, north: 50)))
        XCTAssertFalse(RunGeometry.contains(ring, TestTracks.point(east: 150, north: 50)))
    }

    func testContainsSkipsHoles() {
        let outer = TestTracks.square(side: 100)
        let hole = TestTracks.square(east: 40, north: 40, side: 20)
        XCTAssertFalse(RunGeometry.contains(rings: [outer, hole], TestTracks.point(east: 50, north: 50)))
        XCTAssertTrue(RunGeometry.contains(rings: [outer, hole], TestTracks.point(east: 10, north: 10)))
    }

    func testBearing() {
        let start = TestTracks.point(east: 0, north: 0)
        XCTAssertEqual(RunGeometry.bearing(from: start, to: TestTracks.point(east: 0, north: 500)), 0, accuracy: 1)
        XCTAssertEqual(RunGeometry.bearing(from: start, to: TestTracks.point(east: 500, north: 0)), 90, accuracy: 1)
        XCTAssertEqual(RunGeometry.bearing(from: start, to: TestTracks.point(east: -500, north: 0)), 270, accuracy: 1)
    }

    func testThinnedKeepsEnds() {
        let points = TestTracks.square(side: 1000, step: 1)
        let thinned = RunGeometry.thinned(points, maxPoints: 300)
        XCTAssertEqual(thinned.count, 300)
        XCTAssertEqual(thinned.first?.latitude, points.first?.latitude)
        XCTAssertEqual(thinned.last?.latitude, points.last?.latitude)
    }
}

final class RunPreviewTests: XCTestCase {
    func testTooSmallIsNoTerritory() {
        XCTAssertNil(RunPreviewCalculator.preview(path: TestTracks.square(side: 8, step: 2), territories: [], myUserId: "me"))
    }

    func testAreaAndSteal() throws {
        // Rival owns the east half of the square; my own territory doesn't count as a steal
        let rival = TestTracks.territory(userId: "ana", name: "Ana", east: 50, north: -20, width: 100, height: 140)
        let mine = TestTracks.territory(userId: "me", name: "Yo", east: -20, north: -20, width: 60, height: 140)
        let preview = try XCTUnwrap(RunPreviewCalculator.preview(path: TestTracks.square(side: 100), territories: [rival, mine], myUserId: "me"))
        XCTAssertEqual(preview.area, 10_000, accuracy: 400)
        XCTAssertEqual(preview.steals.count, 1)
        XCTAssertEqual(preview.steals.first?.name, "Ana")
        XCTAssertEqual(preview.steals.first?.area ?? 0, 5_000, accuracy: 750)
        XCTAssertEqual(preview.ring.first?.latitude, preview.ring.last?.latitude)
    }
}

final class RunZoneDetectorTests: XCTestCase {
    func testChangeNeedsTwoFixes() {
        let rival = TestTracks.territory(userId: "ana", name: "Ana", east: 0, north: 0, width: 100, height: 100)
        var detector = RunZoneDetector()
        let inside = TestTracks.point(east: 50, north: 50)
        XCTAssertNil(detector.update(at: inside, territories: [rival], myUserId: "me"))
        XCTAssertEqual(detector.update(at: inside, territories: [rival], myUserId: "me"), RunZoneDetector.Zone.rival(userId: "ana", name: "Ana"))
        XCTAssertEqual(detector.zone.text, "En territorio de Ana")
        // Already there: no new event
        XCTAssertNil(detector.update(at: inside, territories: [rival], myUserId: "me"))
        // A single fix outside (GPS jitter on the border) doesn't leave the zone
        let outside = TestTracks.point(east: 150, north: 50)
        XCTAssertNil(detector.update(at: outside, territories: [rival], myUserId: "me"))
        XCTAssertNil(detector.update(at: inside, territories: [rival], myUserId: "me"))
        XCTAssertTrue(detector.zone.isRival)
    }

    func testMine() {
        let mine = TestTracks.territory(userId: "me", name: "Yo", east: 0, north: 0, width: 100, height: 100)
        var detector = RunZoneDetector()
        let inside = TestTracks.point(east: 10, north: 10)
        _ = detector.update(at: inside, territories: [mine], myUserId: "me")
        XCTAssertEqual(detector.update(at: inside, territories: [mine], myUserId: "me"), RunZoneDetector.Zone.mine)
        XCTAssertEqual(RunSpeech.zone(.mine), "Entras en tu territorio.")
    }
}

final class RunPaceAndSplitsTests: XCTestCase {
    func testRecentPace() {
        var pace = RecentPace()
        XCTAssertNil(pace.secondsPerKm)
        // 3 m/s for two minutes, a fix every second
        for second in 0...120 {
            pace.add(movingTime: Double(second), distance: Double(second) * 3)
        }
        XCTAssertEqual(pace.secondsPerKm ?? 0, 1000.0 / 3, accuracy: 2)
    }

    func testLiveSplits() {
        var splits = RunSplits()
        XCTAssertNil(splits.update(distance: 990, movingTime: 300))
        let first = splits.update(distance: 1004, movingTime: 305)
        XCTAssertEqual(first, RunSplits.Split(km: 1, seconds: 305))
        XCTAssertNil(splits.update(distance: 1500, movingTime: 460))
        XCTAssertEqual(splits.update(distance: 2001, movingTime: 600)?.seconds, 295)
    }

    func testRestartAfterRecovery() {
        var splits = RunSplits()
        splits.restart(distance: 2400, movingTime: 700)
        XCTAssertNil(splits.update(distance: 2900, movingTime: 850))
        XCTAssertEqual(splits.update(distance: 3000, movingTime: 880), RunSplits.Split(km: 3, seconds: 180))
    }

    func testSplitsFromPoints() {
        // 1 point every 100 m, 30 s each: 300 s/km
        let distances = (0...25).map { Double($0) * 100 }
        let times = (0...25).map { Double($0) * 30 }
        let splits = RunSplits.from(distances: distances, times: times)
        XCTAssertEqual(splits.count, 2)
        XCTAssertEqual(splits[0].seconds, 300, accuracy: 0.1)
        XCTAssertEqual(splits[1].seconds, 300, accuracy: 0.1)
    }
}

final class AutoPauseTests: XCTestCase {
    func testPausesWhenStoppedAndResumesWhenMoving() {
        var detector = AutoPauseDetector()
        let start = Date()
        let spot = TestTracks.point(east: 0, north: 0)
        detector.reset(at: start)
        XCTAssertEqual(detector.evaluate(speed: 3, coordinate: spot, at: start, isAutoPaused: false), AutoPauseDetector.Decision.none)
        XCTAssertEqual(detector.evaluate(speed: 0.2, coordinate: spot, at: start.addingTimeInterval(4), isAutoPaused: false), AutoPauseDetector.Decision.none)
        XCTAssertEqual(detector.evaluate(speed: 0.1, coordinate: spot, at: start.addingTimeInterval(9), isAutoPaused: false), .pause)
        // Standing still: stays paused
        XCTAssertEqual(detector.evaluate(speed: 0.3, coordinate: spot, at: start.addingTimeInterval(20), isAutoPaused: true), AutoPauseDetector.Decision.none)
        // Two fixes moving: resume
        XCTAssertEqual(detector.evaluate(speed: 2.5, coordinate: spot, at: start.addingTimeInterval(30), isAutoPaused: true), AutoPauseDetector.Decision.none)
        XCTAssertEqual(detector.evaluate(speed: 2.6, coordinate: spot, at: start.addingTimeInterval(31), isAutoPaused: true), .resume)
    }

    func testResumesWhenFarFromWhereItPaused() {
        var detector = AutoPauseDetector()
        let start = Date()
        let spot = TestTracks.point(east: 0, north: 0)
        detector.reset(at: start)
        XCTAssertEqual(detector.evaluate(speed: 0, coordinate: spot, at: start.addingTimeInterval(10), isAutoPaused: false), .pause)
        XCTAssertEqual(detector.evaluate(speed: 0.5, coordinate: TestTracks.point(east: 20, north: 0), at: start.addingTimeInterval(15), isAutoPaused: true), .resume)
    }
}

final class RunSpeechTests: XCTestCase {
    func testTexts() {
        XCTAssertEqual(RunSpeech.duration(312), "5 minutos 12 segundos")
        XCTAssertEqual(RunSpeech.duration(3600 + 60), "1 hora 1 minuto")
        XCTAssertEqual(RunSpeech.treasureNear(meters: 260), "Tesoro a 250 metros.")
        XCTAssertEqual(
            RunSpeech.split(RunSplits.Split(km: 3, seconds: 312), totalTime: 920),
            "Kilómetro 3. Tiempo total, 15 minutos 20 segundos. Último kilómetro a 5 minutos 12 segundos."
        )
    }
}
