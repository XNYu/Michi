import XCTest
@testable import MichiCore

final class NativeCodeSyntaxTests: XCTestCase {
    private func highlighted(_ text: String, _ language: String) -> [NativeCodeSyntax.Token] {
        let tokens = NativeCodeSyntax.tokens(text, language: language)
        // UTF-8 comparison detects normalization changes that String equality
        // alone intentionally considers canonically equivalent.
        XCTAssertEqual(Array(tokens.map(\.text).joined().utf8), Array(text.utf8))
        XCTAssertLessThanOrEqual(tokens.count, NativeCodeSyntax.maximumTokens)
        return tokens
    }

    private func text(_ tokens: [NativeCodeSyntax.Token], kind: NativeCodeSyntax.Kind) -> [String] {
        tokens.filter { $0.kind == kind }.map(\.text)
    }

    private func assertPlain(_ source: String, _ language: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(highlighted(source, language), [.init(text: source, kind: .plain)], file: file, line: line)
    }

    func testJSONKeysStringsNumbersAndLiterals() {
        let source = "{\r\n\t\"名\" : \"é / 👩🏽‍💻\", \"n\": -12.5e+2, \"ok\": true, \"empty\": null\r\n}"
        let tokens = highlighted(source, "json")
        XCTAssertEqual(text(tokens, kind: .property), ["\"名\"", "\"n\"", "\"ok\"", "\"empty\""])
        XCTAssertEqual(text(tokens, kind: .string), ["\"é / 👩🏽‍💻\""])
        XCTAssertEqual(text(tokens, kind: .number), ["-12.5e+2"])
        XCTAssertEqual(text(tokens, kind: .keyword), ["true", "null"])
    }

    func testEscapedJSONQuoteDoesNotEndStringOrStartAComment() {
        let source = #"{"message":"escaped \" // /* not a comment */", "path":"C:\\tmp"}"#
        let tokens = highlighted(source, "json")
        XCTAssertEqual(text(tokens, kind: .string).count, 2)
        XCTAssertTrue(text(tokens, kind: .comment).isEmpty)
    }

    func testJavaScriptCommentsAndKeywordsAreLexicalOnly() {
        let source = "// const ignored\r\nconst title = '/* text */';\n/* let\nreturn */\nlet answer = 42;"
        let tokens = highlighted(source, "javascript")
        XCTAssertEqual(text(tokens, kind: .keyword), ["const", "let"])
        XCTAssertEqual(text(tokens, kind: .comment), ["// const ignored", "/* let\nreturn */"])
        XCTAssertEqual(text(tokens, kind: .string), ["'/* text */'"])
    }

    func testJavaScriptUnicodeLineSeparatorsEndLineComments() {
        let source = "// comment\u{2028}const value = true;\u{2029}return value"
        let tokens = highlighted(source, "js")
        XCTAssertEqual(text(tokens, kind: .comment), ["// comment"])
        XCTAssertEqual(text(tokens, kind: .keyword), ["const", "true", "return"])
    }

    func testTypeScriptAddsItsOwnKeywordsWithoutMatchingIdentifierFragments() {
        let source = "interface Thing { readonly value: number }; const interfaceName = undefined;"
        let tokens = highlighted(source, "ts")
        XCTAssertEqual(text(tokens, kind: .keyword), ["interface", "readonly", "number", "const", "undefined"])
        XCTAssertFalse(text(highlighted(source, "js"), kind: .keyword).contains("interface"))
    }

    func testSimpleMultilineTemplateAndEscapedInterpolationAreOpaqueStrings() {
        let source = "const message = `line 1\nline 2 \\${literal}`;"
        let tokens = highlighted(source, "js")
        XCTAssertEqual(text(tokens, kind: .string), ["`line 1\nline 2 \\${literal}`"])
        XCTAssertEqual(text(tokens, kind: .keyword), ["const"])
    }

    func testUnsupportedJavaScriptRegexSlashAndInterpolationUsePlainFallback() {
        for source in ["const r = /https?:\\/\\//g;", "const n = 12 / 3;", "const x = `hello ${name}`;", "const x = `outer ${`inner`}`;"] {
            assertPlain(source, "js")
        }
    }

    func testPythonTripleQuotedAndPrefixedStrings() {
        let source = "def f():\n\tvalue = r'c:\\tmp\\file'\n\ttext = '''first\n# not comment\nlast'''\n\treturn None # comment\n"
        let tokens = highlighted(source, "python")
        XCTAssertEqual(text(tokens, kind: .keyword), ["def", "return", "None"])
        XCTAssertEqual(text(tokens, kind: .string), ["r'c:\\tmp\\file'", "'''first\n# not comment\nlast'''"])
        XCTAssertEqual(text(tokens, kind: .comment), ["# comment"])
    }

    func testPythonRawEscapedQuoteBytesAndFStringFallback() {
        let source = "value = r'can\\'t'\nother = br\"bytes\"\n"
        XCTAssertEqual(text(highlighted(source, "py"), kind: .string), ["r'can\\'t'", "br\"bytes\""])
        assertPlain("value = f'hello {name}'", "python")
        assertPlain("value = rf\"hello {name}\"", "python")
    }

    func testPythonTemplateStringPrefixesPreserveWholeBlockFallback() {
        for prefix in ["t", "T", "tr", "Tr", "tR", "TR", "rt", "Rt", "rT", "RT"] {
            for literal in ["'hello {name}'", "\"{user[\"name\"]}\"", "'''first\n{name}\nlast'''", "\"unfinished {name"] {
                // Earlier keywords/numbers must also become plain; never keep
                // a partially highlighted prefix before an unsupported string.
                let source = "def render():\r\n\tcount = 2\r\n\treturn " + prefix + literal + "\r\n"
                assertPlain(source, "python")
            }
        }
    }

    func testPythonTemplatePrefixLookalikeIdentifiersRemainOrdinaryCode() {
        let source = "template = 'text'\nresult = 'value'\nreturn template"
        let tokens = highlighted(source, "python")
        XCTAssertEqual(text(tokens, kind: .keyword), ["return"])
        XCTAssertEqual(text(tokens, kind: .string), ["'text'", "'value'"])
    }

    func testShellCommentBoundaryQuotesEscapesAndSimpleVariables() {
        let source = "#!/bin/sh\nif true; then\n echo https://host/#part x=#value \\#literal '$HOME' \"value\" $HOME ${HOME} $?\nfi # end\n"
        let tokens = highlighted(source, "sh")
        XCTAssertEqual(text(tokens, kind: .keyword), ["if", "then", "fi"])
        XCTAssertEqual(text(tokens, kind: .comment), ["#!/bin/sh", "# end"])
        XCTAssertEqual(text(tokens, kind: .string), ["'$HOME'", "\"value\""])
        XCTAssertEqual(text(tokens, kind: .variable), ["$HOME", "${HOME}", "$?"])
    }

    func testShellMultilineLiteralAndEscapedCommandSubstitution() {
        let source = "echo 'first\n# literal\nlast' \\$(ignored)"
        let tokens = highlighted(source, "bash")
        XCTAssertEqual(text(tokens, kind: .string), ["'first\n# literal\nlast'"])
        XCTAssertTrue(text(tokens, kind: .comment).isEmpty)
    }

    func testShellUnsupportedSubstitutionsAndHeredocsUsePlainFallback() {
        for source in ["echo $(date)", "echo `date`", "cat <<'EOF'\n# literal\nEOF", "cat <<< text", "echo ${name:-'a b'}", "echo \"${name}\"", "echo \"$(date)\""] {
            assertPlain(source, "shell")
        }
    }

    func testSwiftNestedCommentsAndMultilineRawStrings() {
        let source = "/* outer /* inner */ still outer */\nlet raw = ##\"line \\\" quote #\" stays\"##\nlet multi = \"\"\"\n// text\n\"\"\"\nreturn nil"
        let tokens = highlighted(source, "swift")
        XCTAssertEqual(text(tokens, kind: .comment), ["/* outer /* inner */ still outer */"])
        XCTAssertEqual(text(tokens, kind: .keyword), ["let", "let", "return", "nil"])
        XCTAssertEqual(text(tokens, kind: .string), ["##\"line \\\" quote #\" stays\"##", "\"\"\"\n// text\n\"\"\""])
    }

    func testSwiftEscapedQuotesAndRawMultilineClosingDelimiter() {
        let source = "let quote = \"can\\\"t\"\nlet block = #\"\"\"\n\"\"\" not closed\n\"\"\"#\n"
        let tokens = highlighted(source, "swift")
        XCTAssertEqual(text(tokens, kind: .string), ["\"can\\\"t\"", "#\"\"\"\n\"\"\" not closed\n\"\"\"#"])
    }

    func testSwiftUnsupportedInterpolationAndRegexUsePlainFallback() {
        for source in ["let s = \"hello \\(name)\"", "let s = #\"hello \\#(name)\"#", "let regex = #/a+/ #", "let ratio = a / b"] {
            assertPlain(source, "swift")
        }
    }

    func testNumberFormsAndMemberAccessStaySeparate() {
        let tokens = highlighted("const values = [0xff, 0b101, 0o77, 1_000, .5, 1.25e-2, 123n]; object.name;", "js")
        XCTAssertEqual(text(tokens, kind: .number), ["0xff", "0b101", "0o77", "1_000", ".5", "1.25e-2", "123n"])
    }

    func testUnknownAndMissingLanguagesDoNotGuessFromCode() {
        for language in ["", "text", "plain", "html", "jsx", "tsx", "jsonc", "ruby", "c++", "js extra", String(repeating: "x", count: 65)] {
            assertPlain("const value = 1;\n\"quoted\"", language)
        }
    }

    func testAliasesAndLanguageCaseDoNotAffectContent() {
        for language in ["js", "javascript", " JavaScript\n", "ts", "typescript"] {
            XCTAssertEqual(text(highlighted("const n = true;", language), kind: .keyword), ["const", "true"])
        }
        for language in ["sh", "bash", "shell", "zsh"] {
            XCTAssertEqual(text(highlighted("if true; then echo hello; fi", language), kind: .keyword), ["if", "then", "fi"])
        }
    }

    func testScalarExactnessForDecomposedTextZWJEmojiTabsCRLFAndNull() {
        let source = "let cafe\u{301} = \"e\u{301} 👩🏽‍💻 🇨🇳\"\r\n\t// \u{0} end\n"
        let tokens = highlighted(source, "swift")
        XCTAssertEqual(text(tokens, kind: .keyword), ["let"])
        XCTAssertEqual(text(tokens, kind: .comment), ["// \u{0} end"])
    }

    func testUnfinishedStreamingStringsAndCommentsRetainEveryCharacter() {
        for (source, language, lastKind) in [
            ("let x = \"unfinished\\", "swift", NativeCodeSyntax.Kind.string),
            ("const x = 1; /* unfinished\n", "js", .comment),
            ("value = '''unfinished\n", "python", .string),
            ("echo 'unfinished\n", "sh", .string)
        ] {
            XCTAssertEqual(highlighted(source, language).last?.kind, lastKind)
        }
        let tokens = highlighted("const x = \"unfinished\nlet y = 1", "js")
        XCTAssertEqual(text(tokens, kind: .keyword), ["const", "let"])
    }

    func testEmptyWhitespaceAndPlainInput() {
        for source in ["", " \t\r\n", "someIdentifier", "#", "$"] {
            _ = highlighted(source, "swift")
            _ = highlighted(source, "sh")
        }
        assertPlain("", "json")
    }

    func testUTF8ByteLimitFallsBackWithoutClippingOrNormalizing() {
        assertPlain(String(repeating: "界", count: NativeCodeSyntax.maximumUTF8Bytes / 3 + 1), "swift")
        let atLimit = "let x = 1" + String(repeating: " ", count: NativeCodeSyntax.maximumUTF8Bytes - 9)
        XCTAssertEqual(atLimit.utf8.count, NativeCodeSyntax.maximumUTF8Bytes)
        XCTAssertEqual(text(highlighted(atLimit, "swift"), kind: .keyword), ["let"])
        assertPlain(atLimit + " ", "swift")
    }

    func testTokenLimitFallsBackToOneCompletePlainToken() {
        let source = String(repeating: "let x = 1;\n", count: 500)
        XCTAssertLessThan(source.utf8.count, NativeCodeSyntax.maximumUTF8Bytes)
        assertPlain(source, "swift")
    }

    func testLongHashRunsAndDeepCommentsAreIterativeAndBounded() {
        assertPlain(String(repeating: "#", count: 30_000) + "identifier", "swift")
        let source = String(repeating: "/*", count: 3_000) + "body" + String(repeating: "*/", count: 3_000)
        XCTAssertEqual(highlighted(source, "swift"), [.init(text: source, kind: .comment)])
    }
}
