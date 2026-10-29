import Foundation

extension Array {
    /// The element at `index`, or nil when it's out of range.
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
