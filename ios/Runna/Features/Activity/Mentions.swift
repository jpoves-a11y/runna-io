import SwiftUI

/// Someone who can be @mentioned in a comment (one of your friends).
struct MentionCandidate: Identifiable, Hashable {
    let id: String
    let name: String
    let username: String
    let avatar: String?
    let color: String

    init(_ user: AppUser) {
        id = user.id
        name = user.name
        username = user.username
        avatar = user.avatar
        color = user.color
    }
}

/// @mentions in comments. Uses the same pattern as the server, which pushes a "feed_mention"
/// notification to friends whose name or username matches the mention.
enum Mentions {
    /// Links inside comment text use this scheme; views turn a tap into opening that profile.
    static let urlScheme = "runnaio-mention"

    private static let mentionRegex: NSRegularExpression? =
        try? NSRegularExpression(pattern: "@([\\w\\u00C0-\\u024F]+(?:\\s[\\w\\u00C0-\\u024F]+)?)")

    private static let trailingRegex: NSRegularExpression? =
        try? NSRegularExpression(pattern: "(?:^|\\s)@([\\w\\u00C0-\\u024F]*)$")

    /// The text typed after a trailing "@" (empty right after typing "@"), or nil when not typing a mention.
    static func trailingQuery(in text: String) -> String? {
        guard let trailingRegex else { return nil }
        let ns = text as NSString
        guard let match = trailingRegex.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)),
              match.range(at: 1).location != NSNotFound else { return nil }
        return ns.substring(with: match.range(at: 1))
    }

    /// Replaces the trailing "@query" with "@Name ".
    static func insert(_ person: MentionCandidate, into text: String) -> String {
        guard let query = trailingQuery(in: text) else { return text + "@\(person.name) " }
        let base = String(text.dropLast(query.count + 1))
        return base + "@\(person.name) "
    }

    /// Friends matching what is typed after "@" (by name or username), at most 5.
    static func suggestions(for query: String, among people: [MentionCandidate]) -> [MentionCandidate] {
        let needle = query.lowercased()
        let matches = needle.isEmpty
            ? people
            : people.filter { $0.name.lowercased().contains(needle) || $0.username.lowercased().contains(needle) }
        return Array(matches.prefix(5))
    }

    /// Comment text with mentions in semibold brand colour; mentions of known people become tappable links.
    static func attributed(_ text: String, people: [MentionCandidate]) -> AttributedString {
        guard let mentionRegex, text.contains("@") else { return AttributedString(text) }
        let ns = text as NSString
        let matches = mentionRegex.matches(in: text, range: NSRange(location: 0, length: ns.length))
        guard !matches.isEmpty else { return AttributedString(text) }

        var result = AttributedString()
        var cursor = 0
        for match in matches {
            let full = match.range
            guard full.location >= cursor, match.range(at: 1).location != NSNotFound else { continue }
            let captured = ns.substring(with: match.range(at: 1))

            // "@Ana López" may be a two-word name, or "@Ana" followed by a normal word
            var mentionLength = full.length
            var person = find(captured, in: people)
            if person == nil, let space = captured.firstIndex(where: { $0.isWhitespace }) {
                let firstWord = String(captured[..<space])
                person = find(firstWord, in: people)
                mentionLength = (firstWord as NSString).length + 1
            }

            if full.location > cursor {
                result.append(AttributedString(ns.substring(with: NSRange(location: cursor, length: full.location - cursor))))
            }
            var piece = AttributedString(ns.substring(with: NSRange(location: full.location, length: mentionLength)))
            piece.foregroundColor = Color.brand
            piece.inlinePresentationIntent = .stronglyEmphasized
            if let person, let url = URL(string: "\(urlScheme)://user/\(person.id)") {
                piece.link = url
            }
            result.append(piece)
            cursor = full.location + mentionLength
        }
        if cursor < ns.length {
            result.append(AttributedString(ns.substring(from: cursor)))
        }
        return result
    }

    /// The user id in a mention link, or nil for other URLs.
    static func userId(from url: URL) -> String? {
        guard url.scheme == urlScheme else { return nil }
        let id = url.lastPathComponent
        return id.isEmpty || id == "/" ? nil : id
    }

    private static func find(_ mention: String, in people: [MentionCandidate]) -> MentionCandidate? {
        let needle = mention.lowercased()
        return people.first { $0.name.lowercased() == needle || $0.username.lowercased() == needle }
    }
}

/// Comment text with highlighted @mentions; tapping a mention of a friend calls `onOpenUser`.
struct MentionText: View {
    let text: String
    let people: [MentionCandidate]
    let onOpenUser: (String) -> Void

    var body: some View {
        Text(Mentions.attributed(text, people: people))
            .environment(\.openURL, OpenURLAction { url in
                if let userId = Mentions.userId(from: url) {
                    onOpenUser(userId)
                    return .handled
                }
                return .systemAction
            })
    }
}
