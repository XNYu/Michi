import XCTest
@testable import MichiCore

final class MathDocumentTests: XCTestCase {
    private func formulas(_ text: String) -> [MathExpression] {
        NativeMathSyntax.inline(text).compactMap { if case .math(let value) = $0 { return value }; return nil }
    }
    private func reconstructed(_ text: String) -> String {
        NativeMathSyntax.inline(text).map { switch $0 { case .text(let value): return value; case .math(let value): return value.source } }.joined()
    }
    func testInlineDelimitersAndExactSource() {
        let text = #"before $x^2$ and \(\frac{a}{b}\) after"#
        XCTAssertEqual(formulas(text).map(\.tex), ["x^2", #"\frac{a}{b}"#])
        XCTAssertEqual(reconstructed(text), text)
    }
    func testCodeEscapesAndLinkDestinationsDoNotBecomeFormulas() {
        let text = #"`$code$` ``a `$code$` b`` \$20 [price](https://example.com/$a$/x) and $x$"#
        XCTAssertEqual(formulas(text).map(\.tex), ["x"])
        XCTAssertEqual(reconstructed(text), text)
    }
    func testAutolinkDollarContentAndDestinationRemainUnchanged() {
        let url = "https://example.test/$x$?q=$y$"
        let text = "<\(url)> and $x<y$"
        XCTAssertEqual(formulas(text).map(\.tex), ["x<y"])
        let links = NativeMathSyntax.attributedRuns(text).flatMap { run -> [URL] in
            if case .text(let text) = run { return text.runs.compactMap(\.link) }; return []
        }
        XCTAssertEqual(links, [URL(string: url)!])
        XCTAssertEqual(reconstructed(text), text)
    }
    func testEmailAutolinksAndHTMLAttributesAreNotMathButProseComparisonsAre() {
        let text = #"<dev+$cash$@example.test> <span data-price="$x$">body</span>; a < b and $y$ > c; $x<y$"#
        XCTAssertEqual(formulas(text).map(\.tex), ["y", "x<y"])
        XCTAssertEqual(reconstructed(text), text)
    }
    func testReferenceLinkDefinitionsKeepTheirExactDollarDestinations() {
        let url = "https://example.test/$x$"
        for definition in ["[ref]: \(url)", "[ref]: <\(url)>", "[ref]:\n  \(url)"] {
            let text = definition + "\n\n[go][ref] and $y$"
            XCTAssertEqual(formulas(text).map(\.tex), ["y"], definition)
            let links = NativeMathSyntax.attributedRuns(text).flatMap { run -> [URL] in
                if case .text(let text) = run { return text.runs.compactMap(\.link) }; return []
            }
            XCTAssertEqual(links, [URL(string: url)!], definition)
            XCTAssertEqual(reconstructed(text), text)
        }
    }
    func testTemplateInterpolationsMatchWebRegression() {
        let text = "use ${API_BASE_URL}/workspaces/${id}/watch/stream, see $x^2$"
        XCTAssertEqual(formulas(text).map(\.tex), ["x^2"])
        XCTAssertEqual(reconstructed(text), text)
    }
    func testCurrencyIsLiteralButNumericOperationsAreMath() {
        XCTAssertTrue(formulas("Costs $20 and $30 today; $2$").isEmpty)
        XCTAssertEqual(formulas("$2+2$; $1=1$; $2/3$; $3^2$").map(\.tex), ["2+2", "1=1", "2/3", "3^2"])
        XCTAssertEqual(formulas("costs $5 and $x^2$").map(\.tex), ["x^2"])
        XCTAssertEqual(formulas(#"It costs $5, so \(p=5\)"#).map(\.tex), ["p=5"])
    }
    func testUnfinishedStreamingAndUnmatchedCodePreserveEveryCharacter() {
        for text in ["An unfinished $x^", #"partial \(x +"#, "`code $x$", "$$", "$x\nnew line", #"\(\(\(unclosed"#] {
            XCTAssertTrue(formulas(text).isEmpty, text)
            XCTAssertEqual(reconstructed(text), text)
        }
    }
    func testFormattingAroundFormulaRemainsInTextRuns() {
        let text = #"**a $x$ b** and [energy $E$](https://example.com)"#
        XCTAssertEqual(formulas(text).map(\.tex), ["x", "E"])
        XCTAssertEqual(reconstructed(text), text)
    }
    func testWholeMarkdownAttributesSurviveFormulaPlaceholders() {
        let runs = NativeMathSyntax.attributedRuns("**before $x$ after** and [$E$](https://example.com)")
        let formulas = runs.compactMap { run -> (MathExpression, AttributeContainer)? in
            if case .math(let formula, let attributes) = run { return (formula, attributes) }; return nil
        }
        XCTAssertEqual(formulas.count, 2)
        XCTAssertTrue(formulas[0].1.inlinePresentationIntent?.contains(.stronglyEmphasized) == true)
        XCTAssertEqual(formulas[1].1.link, URL(string: "https://example.com"))
        if case .text(let prefix) = runs.first { XCTAssertTrue(prefix.runs.first?.inlinePresentationIntent?.contains(.stronglyEmphasized) == true) }
        else { XCTFail("Expected formatted prefix") }
    }
    func testExactMichiLinksSurviveInlineRendering() {
        let source = "[Answer](michi://node/n-1?message=m-1) and [Page](michi://page/p-1?block=b-1)"
        let links = NativeMathSyntax.attributedRuns(source).flatMap { run -> [URL] in
            if case .text(let text) = run { return text.runs.compactMap(\.link) }; return []
        }
        XCTAssertEqual(links.map(\.absoluteString), ["michi://node/n-1?message=m-1", "michi://page/p-1?block=b-1"])
        for run in NativeMathSyntax.attributedRuns("[$x$](michi://node/n-1?message=m-1)") {
            if case .math(_, let attributes) = run { XCTAssertEqual(attributes.link?.absoluteString, "michi://node/n-1?message=m-1") }
        }
    }

    func testMalformedInternalLinksStayUntappable() {
        for destination in ["michi://node/n-1?message=m-1&other=x", "michi://page/..", "michi://command/delete", "javascript:alert(1)"] {
            for run in NativeMathSyntax.attributedRuns("[Unsafe](\(destination)) [$x$](\(destination))") {
                if case .text(let text) = run { XCTAssertTrue(text.runs.allSatisfy { $0.link == nil }, destination) }
                if case .math(_, let attributes) = run { XCTAssertNil(attributes.link, destination) }
            }
        }
    }

    func testUnsafeFormulaLinksAreRemovedAndPrivateUseCollisionIsLiteral() {
        for run in NativeMathSyntax.attributedRuns("[$x$](javascript:alert)") {
            if case .math(_, let attributes) = run { XCTAssertNil(attributes.link) }
        }
        let text = "private \u{F0000} and $x$"
        guard case .text(let literal)? = NativeMathSyntax.attributedRuns(text).first else { return XCTFail("Expected lossless fallback") }
        XCTAssertEqual(String(literal.characters), text)
    }
    func testBoundedInlineInputNeverDropsTail() {
        let many = String(repeating: "$x$ ", count: 100)
        XCTAssertEqual(formulas(many).count, 32)
        XCTAssertEqual(reconstructed(many), many)
        let huge = String(repeating: "x", count: 64_001) + "$y$"
        XCTAssertEqual(NativeMathSyntax.inline(huge), [.text(huge)])
    }
    func testUnclosedDelimiterRescansAreBoundedAndLossless() {
        let source = String(repeating: #"\( "#, count: 4_000)
        XCTAssertEqual(NativeMathSyntax.inline(source), [.text(source)])
    }
    func testDisplayMathInterruptsParagraphAndRetainsOriginalDelimiters() {
        let source = "$$\n\\frac{a}{b}\n$$"
        XCTAssertEqual(MarkdownDocument("Before\n" + source + "\nAfter").blocks, [
            .paragraph("Before"), .math(.init(tex: "\n\\frac{a}{b}", source: source, display: true)), .paragraph("After")
        ])
        XCTAssertEqual(MarkdownDocument("$$E = mc^2$$").blocks, [.math(.init(tex: "E = mc^2", source: "$$E = mc^2$$", display: true))])
        XCTAssertEqual(MarkdownDocument(#"\[x^2\]"#).blocks, [.math(.init(tex: "x^2", source: #"\[x^2\]"#, display: true))])
    }
    func testFencedAndIndentedFormulasStayCode() {
        XCTAssertEqual(MarkdownDocument("```tex\n$$x$$\n```").blocks, [.code(language: "tex", text: "$$x$$")])
        XCTAssertEqual(MarkdownDocument("    $$x$$").blocks, [.code(language: "", text: "$$x$$")])
        XCTAssertEqual(MarkdownDocument("$$\nunclosed").blocks, [.paragraph("$$\nunclosed")])
    }
    func testDisplayCloserFollowedByPunctuationDoesNotConsumeNextBlock() {
        let text = "$$E=mc^2$$.\n\n$$\np=mv\n$$"
        XCTAssertEqual(MarkdownDocument(text).blocks, [
            .paragraph("$$E=mc^2$$."), .math(.init(tex: "\np=mv", source: "$$\np=mv\n$$", display: true))
        ])
    }
    func testRadicalDegreeCannotCloseAnOuterBrace() {
        for tex in [#"{\sqrt[a}]"#, #"\sqrt[{x] }"#, #"\sqrt[a"#] {
            XCTAssertNotNil(NativeMathSyntax.rejectionReason(for: tex), tex)
        }
        for tex in [#"\sqrt[{a}]{x}"#, #"{\sqrt[a]{x}}"#, #"\sqrt[\sqrt[3]{x}]{y}"#] {
            XCTAssertNil(NativeMathSyntax.rejectionReason(for: tex), tex)
        }
    }
    func testPreflightAllowsBoundedCommonTeX() {
        for tex in [#"E=mc^2"#, #"\frac{a}{b}"#, #"\sqrt[3]{x}"#, #"\sum_{i=1}^{n} i"#, #"\begin{pmatrix}a&b\\c&d\end{pmatrix}"#, #"\text{Cost}\;\$20"#] {
            XCTAssertNil(NativeMathSyntax.rejectionReason(for: tex), tex)
        }
    }
    func testPreflightAllowsInstalledSwiftMathSubset() {
        for tex in [
            #"f'"#, #"y''"#, #"a~b"#, #"\prime"#, #"x + α"#, #"α+β"#, #"θ ≤ π"#,
            #"f′"#, #"\binom{n}{k}"#,
            #"\left(\frac{a}{b}\right)"#, #"\mathbf{R}"#, #"\mathbb{Z}"#,
            #"\hat{x}+\tilde{y}+\overline{z}"#,
            #"\begin{bmatrix}a&b\\c&d\end{bmatrix}"#,
            #"\begin{vmatrix}1&2\\3&4\end{vmatrix}"#,
            #"\begin{aligned}a&=b\\c&=d\end{aligned}"#,
            #"\begin{cases}a&x>0\\b&x<0\end{cases}"#,
            #"\begin{gather}a+b\end{gather}"#,
            "café",
            #"А + Б"#
        ] {
            XCTAssertNil(NativeMathSyntax.rejectionReason(for: tex), tex)
        }
        XCTAssertEqual(NativeMathSyntax.renderingTeX("f'"), #"f^{\prime}"#)
        XCTAssertEqual(NativeMathSyntax.renderingTeX("y''"), #"y^{\prime\prime}"#)
        XCTAssertEqual(NativeMathSyntax.renderingTeX("f′"), #"f^{\prime}"#)
        XCTAssertEqual(NativeMathSyntax.renderingTeX("a~b"), #"a\,b"#)
        XCTAssertEqual(NativeMathSyntax.renderingTeX(#"f'\text{don't}"#), #"f^{\prime}\text{don't}"#)
        XCTAssertEqual(NativeMathSyntax.renderingTeX("α+β"), #"\alpha+\beta"#)
        XCTAssertEqual(NativeMathSyntax.renderingTeX("ε+φ"), #"\varepsilon+\varphi"#)
        XCTAssertEqual(NativeMathSyntax.renderingTeX("θ≤π"), #"\theta\leq\pi"#)
        XCTAssertEqual(NativeMathSyntax.renderingTeX(#"\text{α}"#), #"\text{α}"#)
    }

    func testPrimeRewriteIsSuperscriptNotBaseline() {
        XCTAssertEqual(NativeMathSyntax.renderingTeX("f'"), #"f^{\prime}"#)
        XCTAssertNotEqual(NativeMathSyntax.renderingTeX("f'"), #"f\prime"#)
        XCTAssertEqual(NativeMathSyntax.renderingTeX("y''"), #"y^{\prime\prime}"#)
        XCTAssertEqual(NativeMathSyntax.renderingTeX(#"f'_n"#), #"f^{\prime}_n"#)
        XCTAssertEqual(NativeMathSyntax.renderingTeX(#"\prime"#), #"\prime"#)
    }

    func testUnicodeRewriteKeepsOriginalSourceAndRejectsUnmapped() {
        let source = "$α + β$"
        XCTAssertEqual(formulas(source).map(\.tex), ["α + β"])
        XCTAssertEqual(reconstructed(source), source)
        XCTAssertEqual(NativeMathSyntax.renderingTeX("α + β"), #"\alpha + \beta"#)
        XCTAssertNotNil(NativeMathSyntax.rejectionReason(for: "x + ς"))
        XCTAssertNotNil(NativeMathSyntax.rejectionReason(for: "x + Ё"))
        XCTAssertNotNil(NativeMathSyntax.rejectionReason(for: "Α"))
    }
    func testPreflightRejectsLossyUnsupportedAndPathologicalInput() {
        for tex in ["", "x + ς", "x% comment", #"\text{don't}"#, #"\color{red}{x}"#, #"\href{https://x}{y}"#, "x\u{0}y", "{x", "x}", "x\\", String(repeating: "x", count: 2_049), String(repeating: "{", count: 13) + "x" + String(repeating: "}", count: 13), String(repeating: #"\sqrt "#, count: 97) + "x"] {
            XCTAssertNotNil(NativeMathSyntax.rejectionReason(for: tex), tex)
        }
    }
    func testEscapedBracesDoNotAffectDepthAndUnknownCommandIsLeftToParser() {
        XCTAssertNil(NativeMathSyntax.rejectionReason(for: #"\{ x \}"#))
        XCTAssertNil(NativeMathSyntax.rejectionReason(for: #"\unknown{x}"#))
    }
}
