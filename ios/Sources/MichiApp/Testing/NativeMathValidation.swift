#if DEBUG
import Foundation
import UIKit

/// Runs inside the fixture app without XCTest's debug-service connection.
/// Exercises the same native renderer as the visible UI, using synthetic data only.
@MainActor enum NativeMathValidation {
    static func runIfRequested() {
        let args = ProcessInfo.processInfo.arguments
        guard args.contains("--uitesting"), args.contains("--validate-math") else { return }
        let cases: [(String, String, Bool)] = [
            ("inline", "E=mc^2", true),
            ("fraction-radical", #"x=\frac{-b\pm\sqrt{b^2-4ac}}{2a}"#, true),
            ("integral", #"\int_0^1 x^2\,dx=\frac{1}{3}"#, true),
            ("matrix", #"\begin{pmatrix}a&b\\c&d\end{pmatrix}"#, true),
            ("matrix-leading-minus", #"\begin{matrix}-2&3\\4&-5\end{matrix}"#, true),
            ("aligned-trailing-row", #"\begin{aligned}a&=b\\\end{aligned}"#, true),
            ("short-cases-row", #"\begin{cases}a&x>0\\b\end{cases}"#, true),
            ("spaced-operator-after-relation", #"x=\,-1"#, false),
            ("spaced-relation-after-operator", #"x+\,=y"#, false),
            ("radical-degree-crosses-brace", #"{\sqrt[a}]"#, false),
            ("empty-fraction-operand", #"\frac{}{x}"#, false),
            ("wide", (1...20).map { "x_{\($0)}" }.joined(separator: "+"), true),
            ("unsupported-command", #"\unknowncommand{x}"#, false),
            ("unclosed-group", #"\frac{a}{b"#, false),
            ("bounded-depth", String(repeating: "{", count: 100) + "x" + String(repeating: "}", count: 100), false),
            ("bounded-input", String(repeating: "x", count: 100_000), false)
        ]
        var entries: [[String: Any]] = []
        for (name, tex, expectedImage) in cases {
            for size in [CGFloat(17), CGFloat(34)] {
                for dark in [false, true] {
                    let result = NativeMathRenderer.render(tex: tex, display: name != "inline", fontSize: size, color: dark ? .white : .black)
                    let image = result.image
                    let finite = image.map { $0.size.width.isFinite && $0.size.height.isFinite && $0.size.width > 0 && $0.size.height > 0 } ?? true
                    let pixels = image?.cgImage?.dataProvider?.data
                    let hasInk: Bool
                    if let pixels {
                        let bytes = CFDataGetBytePtr(pixels)
                        hasInk = bytes.map { buffer in (0..<CFDataGetLength(pixels)).contains { buffer[$0] != 0 } } ?? false
                    } else { hasInk = false }
                    let passed = (image != nil) == expectedImage && finite && (!expectedImage || hasInk) && result.baseline.isFinite
                    entries.append(["case": name, "fontSize": size, "dark": dark, "passed": passed,
                                    "rendered": image != nil, "width": image?.size.width ?? 0,
                                    "height": image?.size.height ?? 0, "fallbackReason": result.fallbackReason ?? ""])
                }
            }
        }
        for size in [CGFloat(17), CGFloat(34)] {
            let automatic = NativeMathRenderer.render(tex: #"\begin{matrix}\frac{1}{2}\end{matrix}"#, display: true, fontSize: size, color: .black)
            let explicit = NativeMathRenderer.render(tex: #"\begin{matrix}\textstyle\frac{1}{2}\end{matrix}"#, display: true, fontSize: size, color: .black)
            let passed = automatic.image != nil && explicit.image != nil && automatic.image?.size == explicit.image?.size
            entries.append(["case": "matrix-preserves-automatic-textstyle", "fontSize": size, "passed": passed,
                            "automaticHeight": automatic.image?.size.height ?? 0, "explicitHeight": explicit.image?.size.height ?? 0])
        }
        let tripleScale = NativeMathRenderer.render(tex: "x^2", display: false, fontSize: 17, color: .black, displayScale: 3)
        let scalePassed = tripleScale.image.map { image in
            image.scale == 3 && image.cgImage?.width == Int(image.size.width * 3)
        } ?? false
        entries.append(["case": "native-three-times-display-scale", "passed": scalePassed])
        let report: [String: Any] = ["passed": entries.allSatisfy { $0["passed"] as? Bool == true },
                                     "count": entries.count, "cases": entries,
                                     "scope": "Synthetic native renderer smoke; not XCUITest or device acceptance"]
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("michi-native-math-validation.json")
        do { try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]).write(to: file, options: .atomic) }
        catch { NSLog("Native math fixture report could not be written: %@", error.localizedDescription) }
    }
}
#endif
