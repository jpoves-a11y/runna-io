import XCTest
import CoreLocation
@testable import Runna

final class RouteAnalysisTests: XCTestCase {
    /// 2,5 km north at 4 m/s (250 s/km), a point every 10 m, with a one-minute stop at 1,2 km
    /// and a steady climb of 10 cm per point.
    private func run() -> (coordinates: [CLLocationCoordinate2D], times: [Double], altitudes: [Double?]) {
        var coordinates: [CLLocationCoordinate2D] = []
        var times: [Double] = []
        var altitudes: [Double?] = []
        var t = 0.0
        for i in 0...250 {
            if i == 120 { t += 60 }
            coordinates.append(TestTracks.point(east: 0, north: Double(i) * 10))
            times.append(t)
            altitudes.append(i % 50 == 7 ? nil : 200 + Double(i) * 0.1)
            t += 2.5
        }
        return (coordinates, times, altitudes)
    }

    func testSplitsIgnoreThePause() throws {
        let track = run()
        let analysis = try XCTUnwrap(RouteAnalysis(coordinates: track.coordinates, times: track.times, altitudes: track.altitudes))
        XCTAssertEqual(analysis.splits.count, 3)
        XCTAssertEqual(analysis.splits[0].length, 1)
        XCTAssertEqual(analysis.splits[2].length, 0.5, accuracy: 0.01)
        for split in analysis.splits {
            XCTAssertEqual(split.pace, 250, accuracy: 8)
        }
    }

    func testPaceSamples() throws {
        let track = run()
        let analysis = try XCTUnwrap(RouteAnalysis(coordinates: track.coordinates, times: track.times, altitudes: nil))
        XCTAssertFalse(analysis.pace.isEmpty)
        XCTAssertTrue(analysis.pace.allSatisfy { abs($0.value - 250) < 10 })
        XCTAssertTrue(analysis.elevation.isEmpty)
    }

    func testElevationGain() throws {
        let track = run()
        let analysis = try XCTUnwrap(RouteAnalysis(coordinates: track.coordinates, times: track.times, altitudes: track.altitudes))
        XCTAssertEqual(analysis.elevationGain, 25, accuracy: 4)
        XCTAssertGreaterThan(analysis.elevation.count, 20)
    }

    func testNeedsTimes() {
        let track = run()
        XCTAssertNil(RouteAnalysis(coordinates: track.coordinates, times: nil, altitudes: nil))
        XCTAssertNil(RouteAnalysis(coordinates: track.coordinates, times: Array(track.times.dropLast()), altitudes: nil))
    }

    func testPaceText() {
        XCTAssertEqual(RouteAnalysis.paceText(312), "5:12")
        XCTAssertEqual(RouteAnalysis.paceText(59.6), "1:00")
    }
}
