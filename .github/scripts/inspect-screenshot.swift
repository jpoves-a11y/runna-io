// Prints the text on a simulator screenshot (Vision OCR) and how many pixels match
// the seeded players' territory colours, so CI logs show what each screen displayed.
// Usage: swift inspect-screenshot.swift screenshot.png
import AppKit
import Vision

let path = CommandLine.arguments[1]
guard let image = NSImage(contentsOfFile: path),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    print("cannot read \(path)")
    exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["es-ES", "en-US"]
request.usesLanguageCorrection = false
try VNImageRequestHandler(cgImage: cgImage).perform([request])
let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
print("text: " + lines.joined(separator: " | "))

// Count pixels close to each player's colour (territory outlines are drawn at full colour)
let width = cgImage.width
let height = cgImage.height
var pixels = [UInt8](repeating: 0, count: width * height * 4)
let context = CGContext(
    data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
    space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
)!
context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))

let colours: [(String, (Int, Int, Int))] = [
    ("alicia-blue #377EB8", (0x37, 0x7E, 0xB8)),
    ("bruno-red #E41A1C", (0xE4, 0x1A, 0x1C)),
    ("carla-green #4DAF4A", (0x4D, 0xAF, 0x4A)),
    ("brand-green #16A34A", (0x16, 0xA3, 0x4A)),
]
var counts = [Int](repeating: 0, count: colours.count)
for i in stride(from: 0, to: pixels.count, by: 4) {
    let r = Int(pixels[i]), g = Int(pixels[i + 1]), b = Int(pixels[i + 2])
    for (index, colour) in colours.enumerated() {
        let (cr, cg, cb) = colour.1
        if abs(r - cr) < 24 && abs(g - cg) < 24 && abs(b - cb) < 24 {
            counts[index] += 1
        }
    }
}
print("colour pixels: " + zip(colours, counts).map { "\($0.0)=\($1)" }.joined(separator: ", "))
