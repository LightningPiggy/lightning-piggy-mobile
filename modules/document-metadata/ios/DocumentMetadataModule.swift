import ExpoModulesCore
import PDFKit

public class DocumentMetadataModule: Module {
  public func definition() -> ModuleDefinition {
    Name("DocumentMetadata")
    AsyncFunction("renderPdfFirstPageAsync") { (fileUri: String, maxWidthPx: Int) -> String? in
      do {
        guard let url = URL(string: fileUri), url.isFileURL else { return nil }
        let source = url.resolvingSymlinksInPath()
        let cache = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        guard source.path.hasPrefix(cache.resolvingSymlinksInPath().path + "/") else { return nil }
        let attributes = try FileManager.default.attributesOfItem(atPath: source.path)
        guard let size = attributes[.size] as? NSNumber, size.intValue > 0,
              size.intValue <= 10 * 1024 * 1024 else { return nil }
        let width = max(1, min(1200, maxWidthPx))
        let target = source.appendingPathExtension("preview-\(width).png")
        if FileManager.default.fileExists(atPath: target.path) { return target.absoluteString }
        guard let document = PDFDocument(url: source), let page = document.page(at: 0) else { return nil }
        let bounds = page.bounds(for: .mediaBox)
        guard bounds.width > 0, bounds.height > 0 else { return nil }
        let height = min(2400, CGFloat(width) * bounds.height / bounds.width)
        let image = page.thumbnail(of: CGSize(width: CGFloat(width), height: height), for: .mediaBox)
        guard let png = image.pngData() else { return nil }
        try png.write(to: target, options: .atomic)
        return target.absoluteString
      } catch { return nil }
    }
  }
}
