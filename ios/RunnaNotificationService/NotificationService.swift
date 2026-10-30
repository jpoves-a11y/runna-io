import UIKit
import UserNotifications

/// Adds the picture of the person a notification is about (who stole your territory, who commented…)
/// as the square on its right. The server sends it as `image: {url, name, color}` with mutable-content;
/// without a picture, or if it can't be downloaded in time, the initials are drawn on their colour.
final class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var content: UNMutableNotificationContent?
    private var delivered = false

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent,
              let image = content.userInfo["image"] as? [String: Any] else {
            contentHandler(request.content)
            return
        }
        self.contentHandler = contentHandler
        self.content = content

        let name = image["name"] as? String ?? ""
        let color = image["color"] as? String ?? "#888888"
        guard let urlString = image["url"] as? String, let url = URL(string: urlString) else {
            deliver(with: Self.initialsImage(name: name, colorHex: color))
            return
        }

        var urlRequest = URLRequest(url: url)
        urlRequest.timeoutInterval = 15
        URLSession.shared.dataTask(with: urlRequest) { [weak self] data, response, _ in
            let ok = (response as? HTTPURLResponse).map { (200..<300).contains($0.statusCode) } ?? false
            let picture = ok ? data.flatMap(UIImage.init(data:)) : nil
            let image = picture.map(Self.squared) ?? Self.initialsImage(name: name, colorHex: color)
            DispatchQueue.main.async { self?.deliver(with: image) }
        }.resume()
    }

    /// Out of time (about 30 s): show the notification as it came, without the picture.
    override func serviceExtensionTimeWillExpire() {
        deliver(with: nil)
    }

    private func deliver(with image: UIImage?) {
        guard !delivered, let content, let contentHandler else { return }
        delivered = true
        if let image, let attachment = Self.attachment(for: image) {
            content.attachments = [attachment]
        }
        contentHandler(content)
    }

    // MARK: - Pictures

    private static let side: CGFloat = 240

    /// The attachment iOS shows as the square thumbnail on the right of the notification.
    private static func attachment(for image: UIImage) -> UNNotificationAttachment? {
        guard let data = image.jpegData(compressionQuality: 0.85) else { return nil }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).jpg")
        do {
            try data.write(to: file)
            return try UNNotificationAttachment(identifier: "person", url: file, options: nil)
        } catch {
            return nil
        }
    }

    /// Centre square of the picture, scaled down.
    private static func squared(_ image: UIImage) -> UIImage {
        let size = image.size
        let crop = min(size.width, size.height)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format).image { _ in
            let scale = side / crop
            let drawSize = CGSize(width: size.width * scale, height: size.height * scale)
            image.draw(in: CGRect(
                x: (side - drawSize.width) / 2,
                y: (side - drawSize.height) / 2,
                width: drawSize.width,
                height: drawSize.height
            ))
        }
    }

    /// Initials in white on the person's territory colour (like the avatars in the app).
    private static func initialsImage(name: String, colorHex: String) -> UIImage {
        let initials = name
            .split(separator: " ")
            .prefix(2)
            .compactMap { $0.first.map(String.init) }
            .joined()
            .uppercased()
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format).image { context in
            color(hex: colorHex).setFill()
            context.fill(CGRect(x: 0, y: 0, width: side, height: side))
            let attributes: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: side * 0.4, weight: .semibold),
                .foregroundColor: UIColor.white,
            ]
            let text = (initials.isEmpty ? "?" : initials) as NSString
            let textSize = text.size(withAttributes: attributes)
            text.draw(at: CGPoint(x: (side - textSize.width) / 2, y: (side - textSize.height) / 2), withAttributes: attributes)
        }
    }

    /// "#RRGGBB" → colour (grey when it can't be read).
    private static func color(hex: String) -> UIColor {
        let digits = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        guard digits.count == 6, let value = UInt32(digits, radix: 16) else { return .systemGray }
        return UIColor(
            red: CGFloat((value >> 16) & 0xFF) / 255,
            green: CGFloat((value >> 8) & 0xFF) / 255,
            blue: CGFloat(value & 0xFF) / 255,
            alpha: 1
        )
    }
}
