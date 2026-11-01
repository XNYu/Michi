import SwiftUI
import UIKit
import SwiftMath
import MichiCore

struct NativeMathRenderResult {
    let image: UIImage?
    /// Distance from the image's lower edge to its mathematical baseline.
    let baseline: CGFloat
    let fallbackReason: String?
}

/// Shared by the production views and the simulator's offline validation fixture.
/// SwiftMath is a native CoreText typesetter; no HTML, JavaScript or network is used.
@MainActor enum NativeMathRenderer {
    private final class Cached: NSObject {
        let result: NativeMathRenderResult
        init(_ result: NativeMathRenderResult) { self.result = result }
    }
    private static let cache: NSCache<NSString, Cached> = {
        let cache = NSCache<NSString, Cached>()
        cache.countLimit = 64; cache.totalCostLimit = 16 * 1_024 * 1_024
        return cache
    }()

    static func render(tex: String, display: Bool, fontSize: CGFloat, color: UIColor, displayScale: CGFloat = 2) -> NativeMathRenderResult {
        func fallback(_ reason: String) -> NativeMathRenderResult { .init(image: nil, baseline: 0, fallbackReason: reason) }
        if let reason = NativeMathSyntax.rejectionReason(for: tex) { return fallback(reason) }
        guard fontSize.isFinite, (8...96).contains(fontSize) else { return fallback("Unsupported formula size") }
        guard displayScale.isFinite, (1...3).contains(displayScale) else { return fallback("Unsupported display scale") }
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
        color.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        let key = "\(display)|\(fontSize)|\(displayScale)|\(red),\(green),\(blue),\(alpha)|\(tex)" as NSString
        if let cached = cache.object(forKey: key) { return cached.result }
        let label = MTMathUILabel(frame: .zero)
        label.displayErrorInline = false
        // The mathList setter serializes and mutates table cells in 1.7.3.
        // Parse via latex, then validate this exact list before any layout.
        label.latex = NativeMathSyntax.renderingTeX(tex)
        guard let list = label.mathList, label.error == nil else {
            let result = fallback("Unsupported or incomplete TeX")
            cache.setObject(Cached(result), forKey: key, cost: tex.utf8.count)
            return result
        }
        var count = 0
        guard validate(list, depth: 0, count: &count), !list.atoms.isEmpty else { return fallback("Unsupported or overly complex formula structure") }
        label.fontSize = fontSize
        label.labelMode = display ? .display : .text
        label.textAlignment = .left
        label.textColor = color
        label.contentInsets = UIEdgeInsets(top: 2, left: 2, bottom: 2, right: 2)
        // 1.7.3 has intrinsic sizing but no line wrapping or maximum-width API.
        let natural = label.intrinsicContentSize
        guard natural.width.isFinite, natural.height.isFinite,
              natural.width > 0, natural.height > 0,
              natural.width <= 2_048, natural.height <= 512,
              natural.width * natural.height * displayScale * displayScale <= 2_097_152 else { return fallback("Formula dimensions exceed the native rendering limit") }
        let size = CGSize(width: ceil(natural.width), height: ceil(max(natural.height, fontSize / 2 + 4)))
        label.frame = CGRect(origin: .zero, size: size)
        label.setNeedsLayout(); label.layoutIfNeeded()
        guard let rendered = label.displayList,
              rendered.ascent.isFinite, rendered.descent.isFinite else { return fallback("Formula could not be laid out") }
        let format = UIGraphicsImageRendererFormat()
        format.scale = displayScale; format.opaque = false
        let image = UIGraphicsImageRenderer(size: size, format: format).image { context in
            // MTDisplay uses CoreText's upward Y axis. Match the pinned upstream
            // MTMathImage implementation; rendering the UIView's flipped layer
            // offscreen produces a vertically mirrored formula.
            context.cgContext.saveGState()
            context.cgContext.translateBy(x: 0, y: size.height)
            context.cgContext.scaleBy(x: 1, y: -1)
            rendered.draw(context.cgContext)
            context.cgContext.restoreGState()
        }
        let baseline = (size.height - 4 - max(rendered.ascent + rendered.descent, fontSize / 2)) / 2 + rendered.descent + 2
        let result = NativeMathRenderResult(image: image, baseline: baseline, fallbackReason: nil)
        cache.setObject(Cached(result), forKey: key, cost: Int(size.width * size.height * displayScale * displayScale * 4))
        return result
    }

    /// Reject shapes that could reach SwiftMath's force-unwrapped child lists or
    /// unbounded table/layout paths. Empty cells are safe; empty operands are not.
    private static func validate(_ list: MTMathList, depth: Int, count: inout Int, allowEmpty: Bool = true) -> Bool {
        guard depth <= 16, allowEmpty || !list.atoms.isEmpty else { return false }
        func child(_ child: MTMathList?, required: Bool = true) -> Bool {
            guard let child else { return !required }
            return validate(child, depth: depth + 1, count: &count, allowEmpty: !required)
        }
        var previous: MTMathAtomType?, separated = false
        for atom in list.atoms {
            count += 1
            guard count <= 512, atom.nucleus.utf8.count <= 256 else { return false }
            if let script = atom.superScript, !child(script) { return false }
            if let script = atom.subScript, !child(script) { return false }
            if atom.type == .space || atom.type == .style { separated = true }
            else {
                if previous == nil, separated, atom.type == .binaryOperator { atom.type = .unaryOperator }
                if let previous, separated {
                    let invalidRightBinary = atom.type == .binaryOperator && [.largeOperator, .binaryOperator, .relation, .open, .punctuation].contains(previous)
                    let invalidLeftBinary = previous == .binaryOperator && [.binaryOperator, .relation, .close, .punctuation].contains(atom.type)
                    guard !invalidRightBinary, !invalidLeftBinary else { return false }
                }
                previous = atom.type; separated = false
            }
            switch atom.type {
            case .fraction:
                guard let fraction = atom as? MTFraction, child(fraction.numerator), child(fraction.denominator) else { return false }
            case .radical:
                guard let radical = atom as? MTRadical, child(radical.radicand) else { return false }
                if let degree = radical.degree, !child(degree) { return false }
            case .inner:
                guard let inner = atom as? MTInner, child(inner.innerList) else { return false }
            case .overline:
                guard let line = atom as? MTOverLine, child(line.innerList) else { return false }
            case .underline:
                guard let line = atom as? MTUnderLine, child(line.innerList) else { return false }
            case .accent:
                guard let accent = atom as? MTAccent, child(accent.innerList) else { return false }
            case .table:
                guard let table = atom as? MTMathTable, (1...8).contains(table.numRows), (1...8).contains(table.numColumns),
                      table.interColumnSpacing.isFinite, table.interRowAdditionalSpacing.isFinite else { return false }
                for row in table.cells {
                    guard row.count <= table.numColumns else { return false }
                    for cell in row { if !validate(cell, depth: depth + 1, count: &count) { return false } }
                }
            case .space:
                guard let space = atom as? MTMathSpace, space.space.isFinite, abs(space.space) <= 100 else { return false }
            case .style: guard atom is MTMathStyle else { return false }
            case .largeOperator: guard atom is MTLargeOperator else { return false }
            case .boundary, .color, .textcolor, .colorBox: return false
            default: break
            }
        }
        return true
    }
}

@MainActor struct NativeMathView: View {
    let tex: String
    var display = true
    var source: String? = nil
    @Environment(\.michiAppearance) private var preferences
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.displayScale) private var displayScale
    @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1
    private var original: String { source ?? tex }
    var body: some View {
        let result = NativeMathRenderer.render(tex: tex, display: display, fontSize: min(96, CGFloat(preferences.messageSize) * scale), color: nativeFormulaColor(colorScheme), displayScale: displayScale)
        VStack(alignment: .leading, spacing: 8) {
            if let image = result.image {
                ScrollView(.horizontal) {
                    Image(uiImage: image).fixedSize()
                        .accessibilityLabel("Formula, TeX: " + tex)
                }
                DisclosureGroup("TeX source") { sourceView }
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                Text(result.fallbackReason ?? "Formula source").font(.caption).foregroundStyle(.secondary)
                sourceView
            }
        }.contextMenu {
            Button("Copy TeX", systemImage: "doc.on.doc") { UIPasteboard.general.string = tex }
            ShareLink(item: original) { Label("Share formula source", systemImage: "square.and.arrow.up") }
        }
    }
    private var sourceView: some View {
        Text(verbatim: original).font(.system(.body, design: .monospaced))
            .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// SwiftUI Text keeps native inline wrapping and Markdown attributes; formulas are
/// CoreText-rendered attachments. The explicit copy action retains every delimiter.
@MainActor struct NativeMathInlineText: View {
    let text: String
    var alignment: Alignment = .leading
    @Environment(\.michiAppearance) private var preferences
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.displayScale) private var displayScale
    @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1
    @State private var availableWidth: CGFloat = 0
    var body: some View {
        let runs = NativeMathSyntax.attributedRuns(text)
        let hasMath = runs.contains { if case .math = $0 { return true }; return false }
        if hasMath {
            content(runs).textSelection(.enabled).frame(maxWidth: .infinity, alignment: alignment)
                .accessibilityLabel(accessibilityText(runs))
                .background {
                    GeometryReader { geometry in
                        Color.clear.onAppear { availableWidth = geometry.size.width }
                            .onChange(of: geometry.size.width) { _, width in availableWidth = width }
                    }
                }
                .contextMenu {
                    Button("Copy text with TeX", systemImage: "doc.on.doc") { UIPasteboard.general.string = text }
                    ShareLink(item: text) { Label("Share text", systemImage: "square.and.arrow.up") }
                }
        } else {
            content(runs).textSelection(.enabled).frame(maxWidth: .infinity, alignment: alignment)
        }
    }
    private func content(_ runs: [MathAttributedRun]) -> Text {
        NativeMathInlineLayout.markdown(
            runs,
            fontSize: min(96, CGFloat(preferences.messageSize) * scale),
            color: nativeFormulaColor(colorScheme),
            displayScale: displayScale,
            availableWidth: availableWidth
        )
    }
    private func accessibilityText(_ runs: [MathAttributedRun]) -> String {
        runs.map { run in
            switch run {
            case .text(let value): return String(value.characters)
            case .math(let expression, _): return " Formula: " + expression.tex + ". "
            }
        }.joined()
    }
}

@MainActor enum NativeMathInlineLayout {
    static func markdown(
        _ runs: [MathAttributedRun],
        fontSize: CGFloat,
        color: UIColor,
        displayScale: CGFloat,
        availableWidth: CGFloat
    ) -> Text {
        var result = Text("")
        for run in runs {
            switch run {
            case .text(let value): result = result + Text(value)
            case .math(let expression, let attributes):
                result = result + math(expression, attributes: attributes, fontSize: fontSize, color: color, displayScale: displayScale, availableWidth: availableWidth)
            }
        }
        return result
    }

    static func html(
        _ source: String,
        attributes: AttributeContainer,
        fontSize: CGFloat,
        color: UIColor,
        displayScale: CGFloat,
        availableWidth: CGFloat
    ) -> Text {
        var result = Text("")
        for run in NativeMathSyntax.inline(source) {
            switch run {
            case .text(let value):
                result = result + Text(AttributedString(value, attributes: attributes))
            case .math(let expression):
                result = result + math(expression, attributes: attributes, fontSize: fontSize, color: color, displayScale: displayScale, availableWidth: availableWidth)
            }
        }
        return result
    }

    private static func math(
        _ expression: MathExpression,
        attributes: AttributeContainer,
        fontSize: CGFloat,
        color: UIColor,
        displayScale: CGFloat,
        availableWidth: CGFloat
    ) -> Text {
        if attributes.link != nil {
            return Text(AttributedString(expression.source, attributes: attributes))
        }
        let rendered = NativeMathRenderer.render(
            tex: expression.tex,
            display: expression.display,
            fontSize: fontSize,
            color: color,
            displayScale: displayScale
        )
        if let image = rendered.image, availableWidth > 0, image.size.width <= availableWidth {
            return Text(Image(uiImage: image)).baselineOffset(-rendered.baseline)
        }
        return Text(AttributedString(expression.source, attributes: attributes))
    }
}

func nativeFormulaColor(_ scheme: ColorScheme) -> UIColor {
    UIColor.label.resolvedColor(with: UITraitCollection(userInterfaceStyle: scheme == .dark ? .dark : .light))
}
