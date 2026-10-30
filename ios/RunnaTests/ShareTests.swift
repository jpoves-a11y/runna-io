import XCTest
import CoreLocation
@testable import Runna

final class ShareGeometryTests: XCTestCase {
    func testFitKeepsShapeInsideTheBox() {
        // 400 m wide, 100 m tall: fits the width, centred vertically
        let route = [
            TestTracks.point(east: 0, north: 0), TestTracks.point(east: 400, north: 0),
            TestTracks.point(east: 400, north: 100), TestTracks.point(east: 0, north: 100),
        ]
        let points = ShareGeometry.fit(route, in: CGRect(x: 0, y: 0, width: 200, height: 200), padding: 10)
        let xs = points.map(\.x), ys = points.map(\.y)
        XCTAssertEqual(xs.min() ?? 0, 10, accuracy: 0.5)
        XCTAssertEqual(xs.max() ?? 0, 190, accuracy: 0.5)
        XCTAssertEqual((ys.max() ?? 0) - (ys.min() ?? 0), 45, accuracy: 2)
        XCTAssertEqual(((ys.max() ?? 0) + (ys.min() ?? 0)) / 2, 100, accuracy: 0.5)
        // North up: the northern points are higher (smaller y)
        XCTAssertLessThan(points[2].y, points[1].y)
    }

    func testFileNameIsSafeAndBranded() {
        func run(_ name: String) -> ShareRun {
            ShareRun(routeId: nil, name: name, date: nil, coordinates: [], distance: 0, duration: 0, colorHex: "#16A34A")
        }
        XCTAssertEqual(run("Rodaje 10/2: río").fileBaseName, "RUNNA.IO-Rodaje 10-2- río")
        XCTAssertEqual(run("  ").fileBaseName, "RUNNA.IO-Carrera")
    }

    func testPrefixEndsBetweenPoints() {
        let points = [CGPoint(x: 0, y: 0), CGPoint(x: 10, y: 0), CGPoint(x: 20, y: 0)]
        let half = ShareMapRenderer.prefix(points, progress: 0.75)
        XCTAssertEqual(half.count, 3)
        XCTAssertEqual(half.last?.x ?? 0, 15, accuracy: 0.001)
        XCTAssertEqual(ShareMapRenderer.prefix(points, progress: 1).count, 3)
    }
}

final class ShareVideoTimelineTests: XCTestCase {
    func testDurationFollowsDistanceAndSpeed() {
        let short = ShareVideoRenderer.Timeline(distanceMeters: 1_000, speed: 1)
        let long = ShareVideoRenderer.Timeline(distanceMeters: 30_000, speed: 1)
        XCTAssertEqual(short.draw, 5, accuracy: 0.01)
        XCTAssertEqual(long.draw, 10, accuracy: 0.01)
        let fast = ShareVideoRenderer.Timeline(distanceMeters: 5_000, speed: 2)
        let normal = ShareVideoRenderer.Timeline(distanceMeters: 5_000, speed: 1)
        XCTAssertEqual(fast.draw * 2, normal.draw, accuracy: 0.01)
        XCTAssertEqual(normal.frameCount, Int((normal.total * 30).rounded()))
        XCTAssertGreaterThan(normal.total, 10)
        XCTAssertLessThan(normal.total, 20)
    }
}
