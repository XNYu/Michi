import CoreGraphics
import XCTest
@testable import MichiCore

final class MermaidEntityDiagramTests: XCTestCase {
    func testClassNamesAttributesMethodsRelationshipsAndCardinality() throws {
        let source = """
        classDiagram
        direction LR
        class Animal {
        +String name
        -int age
        #eat()
        ~sleep()$
        }
        class Duck {
        +String beakColor
        +quack()*
        }
        Animal "1" <|-- "many" Duck : inherits
        Animal *-- Heart : has
        Duck ..> Pond : uses
        """
        let graph = try XCTUnwrap(MarkdownClassDiagram.parse(source))
        XCTAssertEqual(graph.source, source)
        XCTAssertEqual(graph.direction, .leftToRight)
        XCTAssertEqual(graph.classes.map(\.id), ["Animal", "Duck", "Heart", "Pond"])
        XCTAssertEqual(graph.classes[0].members.map { "\($0.visibility?.rawValue ?? "")\($0.text)\($0.classifier?.rawValue ?? "")" },
                       ["+String name", "-int age", "#eat()", "~sleep()$"])
        XCTAssertEqual(graph.classes[0].members.map(\.kind), [.attribute, .attribute, .method, .method])
        XCTAssertEqual(graph.classes[1].members.map(\.classifier), [nil, .abstractMember])
        XCTAssertEqual(graph.relations.map(\.kind), [.inheritance, .composition, .dependency])
        XCTAssertEqual(graph.relations.map(\.token), ["<|--", "*--", "..>"])
        XCTAssertEqual(graph.relations[0].leftCardinality, "1")
        XCTAssertEqual(graph.relations[0].rightCardinality, "many")
        XCTAssertEqual(graph.relations[0].from, "Duck")
        XCTAssertEqual(graph.relations[0].to, "Animal")
        XCTAssertEqual(graph.relations[0].label, "inherits")
        let spoken = graph.accessibilityDescription
        for phrase in ["Class Animal.", "public attribute String name", "private attribute int age",
                       "protected method eat()", "package method sleep(), static",
                       "Duck inherits Animal", "cardinality 1 at Animal, many at Duck",
                       "Animal composes Heart: has", "Duck depends on Pond: uses"] {
            XCTAssertTrue(spoken.contains(phrase), phrase)
        }
    }

    func testClassColonMembersImplicitTypesUnicodeAndExactCRLF() throws {
        let source = "classDiagram\r\n%% comment\r\nAnimal : +String 名称\r\nAnimal : +eat()\r\nAnimal <|-- Duck : 继承"
        let graph = try XCTUnwrap(MarkdownClassDiagram.parse(source))
        XCTAssertEqual(graph.source, source)
        XCTAssertEqual(graph.classes.map(\.id), ["Animal", "Duck"])
        XCTAssertEqual(graph.classes[0].members.map(\.text), ["String 名称", "eat()"])
        XCTAssertEqual(graph.classes[0].members.map(\.kind), [.attribute, .method])
        XCTAssertTrue(graph.accessibilityDescription.contains("名称"))
        XCTAssertTrue(graph.accessibilityDescription.contains("继承"))
    }

    func testClassDuplicateIdsAndUnsupportedSyntaxKeepExactSource() {
        let bodies = [
            "class Animal\nclass Animal",
            "class Square~Shape~",
            "class Animal[\"Animal class\"]",
            "<<interface>> Shape",
            "namespace Base {\nclass Animal\n}",
            "note for Animal \"text\"",
            "click Animal href \"https://example.com\"",
            "cssClass \"hot\" Animal",
            "class Animal { +int age }",
            "class Animal {\n+int age; +eat()\n}",
            "class Animal {\n+List~int~ items\n}",
            "Animal ()-- Shape",
            "Class01 1 -- * Class02",
            "Animal <--> Duck",
            "accTitle: title",
            "%%{init: {\"theme\":\"dark\"}}%%\nclass Animal",
            "class Animal {\n+eat(<b>x</b>)\n}",
            "class end",
            "class Animal {\n",
            "class Animal {\n+age\n}\n}",
            "direction RL\nclass A\ndirection TB"
        ]
        for body in bodies {
            let source = "classDiagram\n" + body
            XCTAssertNil(MarkdownClassDiagram.parse(source), body)
            XCTAssertEqual(MarkdownDocument("```mermaid\n\(source)\n```").blocks, [.code(language: "mermaid", text: source)], body)
        }
    }

    func testClassBoundsAcceptBoundaryAndRejectNext() throws {
        let twelve = (0..<12).map { "class C\($0)" }.joined(separator: "\n")
        XCTAssertEqual(try XCTUnwrap(MarkdownClassDiagram.parse("classDiagram\n" + twelve)).classes.count, 12)
        XCTAssertNil(MarkdownClassDiagram.parse("classDiagram\n" + twelve + "\nclass C12"))
        let members = (0..<8).map { "+m\($0)" }.joined(separator: "\n")
        XCTAssertEqual(try XCTUnwrap(MarkdownClassDiagram.parse("classDiagram\nclass A {\n\(members)\n}")).classes[0].members.count, 8)
        XCTAssertNil(MarkdownClassDiagram.parse("classDiagram\nclass A {\n\(members)\n+m8\n}"))
        let relations = (0..<16).map { _ in "A --> B" }.joined(separator: "\n")
        XCTAssertEqual(try XCTUnwrap(MarkdownClassDiagram.parse("classDiagram\nclass A\nclass B\n" + relations)).relations.count, 16)
        XCTAssertNil(MarkdownClassDiagram.parse("classDiagram\nclass A\nclass B\n" + relations + "\nA --> B"))
        XCTAssertNil(MarkdownClassDiagram.parse("classDiagram\nclass A {\n+" + String(repeating: "x", count: 81) + "\n}"))
        XCTAssertNil(MarkdownClassDiagram.parse(String(repeating: "x", count: 12_001)))
        XCTAssertNil(MarkdownClassDiagram.parse("classDiagram\n" + String(repeating: "%% c\n", count: 160)))
    }

    func testClassLayoutDeterministicBoundedAndKeepsRelationGeometry() throws {
        let graph = try XCTUnwrap(MarkdownClassDiagram.parse("classDiagram\nclass A {\n+x\n}\nclass B\nA \"1\" *-- \"0..1\" B : owns"))
        let layout = MarkdownClassDiagramLayout(diagram: graph)
        XCTAssertEqual(layout, MarkdownClassDiagramLayout(diagram: graph))
        XCTAssertLessThanOrEqual(layout.size.width, 8_192)
        XCTAssertLessThanOrEqual(layout.size.height, 8_192)
        XCTAssertTrue(layout.size.width.isFinite && layout.size.height.isFinite)
        XCTAssertEqual(layout.boxes.map(\.id), ["A", "B"])
        XCTAssertFalse(layout.boxes[0].rect.intersects(layout.boxes[1].rect))
        XCTAssertEqual(layout.edges.count, 1)
        XCTAssertGreaterThanOrEqual(layout.edges[0].points.count, 2)
        let left = layout.boxes[0].rect, right = layout.boxes[1].rect
        XCTAssertLessThan(layout.edges[0].leftCardinality.y, layout.edges[0].rightCardinality.y)
        XCTAssertEqual(layout.edges[0].leftCardinality.x, left.midX, accuracy: 0.5)
        XCTAssertEqual(layout.edges[0].rightCardinality.x, right.midX, accuracy: 0.5)
        let infinite = MarkdownClassDiagramLayout(diagram: graph, boxSizes: ["A": CGSize(width: CGFloat.infinity, height: 40)])
        XCTAssertEqual(infinite.size.width, CGFloat.infinity)
        XCTAssertTrue(infinite.boxes.isEmpty)
    }

    func testERAttributesCardinalitiesLabelsAndUnicode() throws {
        let source = """
        erDiagram
        CUSTOMER ||--o{ ORDER : places
        CUSTOMER }o..|| ADDRESS : "送货"
        CUSTOMER {
        string name PK
        string sector
        }
        ORDER {
        int orderNumber PK, FK
        string note
        }
        """
        let graph = try XCTUnwrap(MarkdownERDiagram.parse(source))
        XCTAssertEqual(graph.source, source)
        XCTAssertEqual(graph.entities.map(\.id), ["CUSTOMER", "ORDER", "ADDRESS"])
        XCTAssertEqual(graph.entities[0].attributes.map(\.name), ["name", "sector"])
        XCTAssertEqual(graph.entities[0].attributes[0].keys, [.primary])
        XCTAssertEqual(graph.entities[1].attributes[0].keys, [.primary, .foreign])
        XCTAssertEqual(graph.relations.map(\.label), ["places", "送货"])
        XCTAssertEqual(graph.relations[0].leftCardinality, .exactlyOne)
        XCTAssertEqual(graph.relations[0].rightCardinality, .zeroOrMore)
        XCTAssertTrue(graph.relations[0].identifying)
        XCTAssertEqual(graph.relations[1].leftCardinality, .zeroOrMore)
        XCTAssertEqual(graph.relations[1].rightCardinality, .exactlyOne)
        XCTAssertFalse(graph.relations[1].identifying)
        let spoken = graph.accessibilityDescription
        for phrase in ["Entity CUSTOMER.", "string name, primary key", "int orderNumber, primary key, foreign key",
                       "CUSTOMER places ORDER, exactly one to zero or more, identifying",
                       "CUSTOMER 送货 ADDRESS, zero or more to exactly one, non-identifying"] {
            XCTAssertTrue(spoken.contains(phrase), phrase)
        }
    }

    func testERHyphenatedEntitiesQuotedCommentsAndCRLF() throws {
        let source = "erDiagram\r\nLINE-ITEM ||--|{ SHIPMENT : contains\r\nLINE-ITEM {\r\nstring sku PK \"货号\"\r\n}"
        let graph = try XCTUnwrap(MarkdownERDiagram.parse(source))
        XCTAssertEqual(graph.source, source)
        XCTAssertEqual(graph.entities.map(\.id), ["LINE-ITEM", "SHIPMENT"])
        XCTAssertEqual(graph.entities[0].attributes[0].comment, "货号")
        XCTAssertTrue(graph.accessibilityDescription.contains("货号"))
        XCTAssertEqual(graph.relations[0].rightCardinality, .oneOrMore)
    }

    func testERDuplicateIdsAndUnsupportedSyntaxKeepExactSource() {
        let bodies = [
            "CUSTOMER {\nstring name\n}\nCUSTOMER {\nstring sector\n}",
            "CUSTOMER[\"Customer\"] ||--o{ ORDER : places",
            "CUSTOMER ||--o{ ORDER : places\ndirection TB",
            "CUSTOMER ||--x{ ORDER : places",
            "CUSTOMER }|--|{ ORDER",
            "CUSTOMER ||--o{ ORDER : <b>x</b>",
            "CUSTOMER {\nstring name PK, XX\n}",
            "CUSTOMER {\nstring List~T~ items\n}",
            "note left of CUSTOMER : x",
            "accTitle: title",
            "%%{init: {}}%%\nA ||--|| B : x",
            "CUSTOMER {\nstring name\n",
            "CUSTOMER {\nstring name\n}\n}",
            "CUSTOMER {\nCUSTOMER ||--o{ ORDER : places\n}"
        ]
        for body in bodies {
            let source = "erDiagram\n" + body
            XCTAssertNil(MarkdownERDiagram.parse(source), body)
            XCTAssertEqual(MarkdownDocument("```mermaid\n\(source)\n```").blocks, [.code(language: "mermaid", text: source)], body)
        }
    }

    func testERBoundsAndLayout() throws {
        let twelve = (0..<12).map { "E\($0) {\nstring n\n}" }.joined(separator: "\n")
        XCTAssertEqual(try XCTUnwrap(MarkdownERDiagram.parse("erDiagram\n" + twelve)).entities.count, 12)
        XCTAssertNil(MarkdownERDiagram.parse("erDiagram\n" + twelve + "\nE12 {\nstring n\n}"))
        let attrs = (0..<8).map { "string a\($0)" }.joined(separator: "\n")
        XCTAssertEqual(try XCTUnwrap(MarkdownERDiagram.parse("erDiagram\nE {\n\(attrs)\n}")).entities[0].attributes.count, 8)
        XCTAssertNil(MarkdownERDiagram.parse("erDiagram\nE {\n\(attrs)\nstring a8\n}"))
        let rels = (0..<16).map { "A ||--|| B : r\($0)" }.joined(separator: "\n")
        XCTAssertEqual(try XCTUnwrap(MarkdownERDiagram.parse("erDiagram\n" + rels)).relations.count, 16)
        XCTAssertNil(MarkdownERDiagram.parse("erDiagram\n" + rels + "\nA ||--|| B : extra"))
        let graph = try XCTUnwrap(MarkdownERDiagram.parse("erDiagram\nA ||--o{ B : links"))
        let layout = MarkdownERDiagramLayout(diagram: graph)
        XCTAssertEqual(layout, MarkdownERDiagramLayout(diagram: graph))
        XCTAssertLessThanOrEqual(layout.size.width, 8_192)
        XCTAssertFalse(layout.boxes[0].rect.intersects(layout.boxes[1].rect))
        XCTAssertGreaterThanOrEqual(layout.edges[0].points.count, 2)
    }

    func testPieTitleShowDataQuotedValuesAndPercents() throws {
        let source = "pie showData\ntitle Pets adopted\n\"Dogs\" : 386\n\"Cats\" : 85\n\"Rats\" : 15"
        let graph = try XCTUnwrap(MarkdownPieChart.parse(source))
        XCTAssertEqual(graph.source, source)
        XCTAssertEqual(graph.title, "Pets adopted")
        XCTAssertTrue(graph.showData)
        XCTAssertEqual(graph.slices.map(\.label), ["Dogs", "Cats", "Rats"])
        XCTAssertEqual(graph.slices.map(\.value), [386, 85, 15])
        XCTAssertEqual(graph.total, 486)
        XCTAssertTrue(graph.accessibilityDescription.contains("Showing values"))
        XCTAssertTrue(graph.accessibilityDescription.contains("Dogs 386, 79.4 percent"))
        let header = try XCTUnwrap(MarkdownPieChart.parse("pie showData title Key elements\n\"Calcium\" : 42.96\n\"Iron\" : 5"))
        XCTAssertEqual(header.title, "Key elements")
        XCTAssertTrue(header.showData)
        XCTAssertEqual(header.slices.map(\.value), [42.96, 5])
    }

    func testPieZeroNonfiniteNegativeAndTotalsRejectOrKeep() throws {
        let withZero = try XCTUnwrap(MarkdownPieChart.parse("pie\n\"Kept\" : 10\n\"Empty\" : 0"))
        XCTAssertEqual(withZero.slices.map(\.value), [10, 0])
        XCTAssertEqual(withZero.total, 10)
        XCTAssertEqual(MarkdownPieChartLayout(diagram: withZero).slices[1].percent, 0)
        XCTAssertEqual(MarkdownPieChartLayout(diagram: withZero).slices[1].start, MarkdownPieChartLayout(diagram: withZero).slices[1].end)
        for source in [
            "pie\n\"A\" : 0",
            "pie\n\"A\" : -1",
            "pie\n\"A\" : +10",
            "pie\n\"A\" : nan",
            "pie\n\"A\" : NaN",
            "pie\n\"A\" : inf",
            "pie\n\"A\" : Infinity",
            "pie\n\"A\" : 1e309",
            "pie\n\"A\" : 1e-2",
            "pie\nDogs : 386",
            "pie\n\"A\" : 1\n\"A\" : 2",
            "pie title",
            "pie\n\"A\" : 1\n%%{init: {}}%%"
        ] {
            XCTAssertNil(MarkdownPieChart.parse(source), source)
            XCTAssertEqual(MarkdownDocument("```mermaid\n\(source)\n```").blocks, [.code(language: "mermaid", text: source)], source)
        }
    }

    func testPieUnicodeSourceBoundsAndLayout() throws {
        let source = "pie title 宠物\n\"狗\" : 3\n\"猫\" : 1"
        let graph = try XCTUnwrap(MarkdownPieChart.parse(source))
        XCTAssertEqual(graph.source, source)
        XCTAssertEqual(graph.title, "宠物")
        XCTAssertEqual(graph.slices.map(\.label), ["狗", "猫"])
        let layout = MarkdownPieChartLayout(diagram: graph)
        XCTAssertEqual(layout, MarkdownPieChartLayout(diagram: graph))
        XCTAssertEqual(layout.total, 4)
        XCTAssertEqual(layout.slices.map(\.percent), [75, 25])
        XCTAssertEqual(layout.slices[0].start, -.pi / 2, accuracy: 1e-9)
        XCTAssertEqual(layout.slices[0].end, -.pi / 2 + 1.5 * .pi, accuracy: 1e-9)
        XCTAssertLessThanOrEqual(layout.diameter, 8_192)
        XCTAssertNil(MarkdownPieChart.parse("pie\n" + (0...12).map { "\"S\($0)\" : 1" }.joined(separator: "\n")))
        XCTAssertNotNil(MarkdownPieChart.parse("pie\n" + (0..<12).map { "\"S\($0)\" : 1" }.joined(separator: "\n")))
        XCTAssertNil(MarkdownPieChart.parse("pie\n\"\(String(repeating: "x", count: 81))\" : 1"))
        let crlf = "pie\r\n\"A\" : 1\r\n\"B\" : 1"
        XCTAssertEqual(try XCTUnwrap(MarkdownPieChart.parse(crlf)).source, crlf)
    }

    func testMarkdownDispatcherCoversNewTypesWithoutWeakeningFallback() {
        let classSource = "classDiagram\nclass Animal"
        let erSource = "erDiagram\nA ||--|| B : links"
        let pieSource = "pie\n\"Dogs\" : 1"
        guard case .classDiagram(let classes)? = MarkdownDocument("```mermaid\n\(classSource)\n```").blocks.first else { return XCTFail("class") }
        guard case .erDiagram(let er)? = MarkdownDocument("```mermaid\n\(erSource)\n```").blocks.first else { return XCTFail("er") }
        guard case .pieChart(let pie)? = MarkdownDocument("```mermaid\n\(pieSource)\n```").blocks.first else { return XCTFail("pie") }
        XCTAssertEqual(classes, MarkdownClassDiagram.parse(classSource))
        XCTAssertEqual(er, MarkdownERDiagram.parse(erSource))
        XCTAssertEqual(pie, MarkdownPieChart.parse(pieSource))
        XCTAssertEqual(MarkdownDocument.mermaidBlock(classSource), .classDiagram(classes))
        XCTAssertEqual(MarkdownDocument.mermaidBlock(erSource), .erDiagram(er))
        XCTAssertEqual(MarkdownDocument.mermaidBlock(pieSource), .pieChart(pie))
        guard case .flowchart? = MarkdownDocument("```mermaid\nflowchart LR\nA --> B\n```").blocks.first else { return XCTFail("flowchart") }
        guard case .sequenceDiagram? = MarkdownDocument("```mermaid\nsequenceDiagram\nA->>B: hi\n```").blocks.first else { return XCTFail("sequence") }
        guard case .stateDiagram? = MarkdownDocument("```mermaid\nstateDiagram-v2\nA\n```").blocks.first else { return XCTFail("state") }
        let fallback = "classDiagram\nnamespace X {\nclass A\n}"
        XCTAssertEqual(MarkdownDocument("```mermaid\n\(fallback)\n```").blocks, [.code(language: "mermaid", text: fallback)])
        XCTAssertEqual(MarkdownDocument("```text\n\(classSource)\n```").blocks, [.code(language: "text", text: classSource)])
    }

    func testPieHugeFiniteValuesFormatWithoutIntRounding() throws {
        let source = "pie showData\n\"Huge\" : 10000000000000000000\n\"Rest\" : 1"
        let graph = try XCTUnwrap(MarkdownPieChart.parse(source))
        XCTAssertGreaterThan(graph.slices[0].value, Double(Int.max))
        XCTAssertTrue(graph.total.isFinite)
        let spoken = graph.accessibilityDescription
        XCTAssertTrue(spoken.contains("Huge"))
        XCTAssertTrue(spoken.contains(String(format: "%.0f", graph.slices[0].value)), spoken)
        XCTAssertTrue(spoken.contains(String(format: "%.0f", graph.slices[1].value)), spoken)
        let layout = MarkdownPieChartLayout(diagram: graph)
        XCTAssertEqual(layout.slices.count, 2)
        XCTAssertTrue(layout.slices.allSatisfy { $0.start.isFinite && $0.end.isFinite && $0.percent.isFinite })
        XCTAssertEqual(layout.slices[0].percent + layout.slices[1].percent, 100, accuracy: 1e-6)
        XCTAssertEqual(layout.slices[1].end - layout.slices[0].start, 2 * .pi, accuracy: 1e-6)
        XCTAssertLessThan(layout.slices[1].percent, 1)
        XCTAssertGreaterThan(layout.slices[0].percent, 99)
    }

    func testSelfLoopAndSkipEdgesStayInsideCanvasAndAvoidCards() throws {
        let looping = try XCTUnwrap(MarkdownClassDiagram.parse("classDiagram\nclass A\nA --> A : loop"))
        let loopLayout = MarkdownClassDiagramLayout(diagram: looping)
        XCTAssertEqual(loopLayout.edges.count, looping.relations.count)
        XCTAssertGreaterThan(loopLayout.size.width, loopLayout.boxes[0].rect.maxX + 16)
        try assertEntityBounds(size: loopLayout.size, boxes: loopLayout.boxes.map(\.rect), edges: loopLayout.edges.map {
            (points: $0.points, left: $0.leftCardinality, right: $0.rightCardinality, label: $0.label)
        })
        for point in loopLayout.edges[0].points {
            XCTAssertFalse(loopLayout.boxes[0].rect.insetBy(dx: 1, dy: 1).contains(point))
        }

        let skip = try XCTUnwrap(MarkdownERDiagram.parse("erDiagram\nA {\nstring a\n}\nB {\nstring b\n}\nC {\nstring c\n}\nA ||--|| C : skip"))
        XCTAssertEqual(skip.entities.map(\.id), ["A", "B", "C"])
        XCTAssertEqual(skip.relations.count, 1)
        let skipLayout = MarkdownERDiagramLayout(diagram: skip)
        XCTAssertEqual(skipLayout.edges.count, 1)
        XCTAssertEqual(skip.relations[0].leftCardinality, .exactlyOne)
        XCTAssertEqual(skip.relations[0].rightCardinality, .exactlyOne)
        XCTAssertEqual(skip.relations[0].label, "skip")
        try assertEntityBounds(size: skipLayout.size, boxes: skipLayout.boxes.map(\.rect), edges: skipLayout.edges.map {
            (points: $0.points, left: $0.leftCardinality, right: $0.rightCardinality, label: $0.label)
        })
        let middle = skipLayout.boxes[1].rect
        XCTAssertEqual(skipLayout.boxes[1].id, "B")
        for (start, end) in zip(skipLayout.edges[0].points, skipLayout.edges[0].points.dropFirst()) {
            let segment = CGRect(x: min(start.x, end.x), y: min(start.y, end.y),
                                 width: max(0.01, abs(end.x - start.x)), height: max(0.01, abs(end.y - start.y)))
            XCTAssertFalse(segment.intersects(middle.insetBy(dx: 1, dy: 1)))
        }
        XCTAssertFalse(middle.insetBy(dx: 1, dy: 1).contains(skipLayout.edges[0].label))

        let row = try XCTUnwrap(MarkdownClassDiagram.parse("classDiagram\ndirection LR\nclass A\nclass B\nclass C\nA --> C : skip"))
        let rowLayout = MarkdownClassDiagramLayout(diagram: row)
        XCTAssertEqual(rowLayout.edges.count, 1)
        XCTAssertEqual(row.relations[0].from, "A")
        XCTAssertEqual(row.relations[0].to, "C")
        try assertEntityBounds(size: rowLayout.size, boxes: rowLayout.boxes.map(\.rect), edges: rowLayout.edges.map {
            (points: $0.points, left: $0.leftCardinality, right: $0.rightCardinality, label: $0.label)
        })
        let intervening = rowLayout.boxes[1].rect
        XCTAssertEqual(rowLayout.boxes[1].id, "B")
        for (start, end) in zip(rowLayout.edges[0].points, rowLayout.edges[0].points.dropFirst()) {
            let segment = CGRect(x: min(start.x, end.x), y: min(start.y, end.y),
                                 width: max(0.01, abs(end.x - start.x)), height: max(0.01, abs(end.y - start.y)))
            XCTAssertFalse(segment.intersects(intervening.insetBy(dx: 1, dy: 1)))
        }
    }

    func testClassAdjacentEdgeLabelClearsEndpointCardinalities() throws {
        let source = """
        classDiagram
        class Animal {
        +String name
        +eat()
        }
        class Duck {
        +String beakColor
        +quack()
        }
        Animal "1" <|-- "many" Duck : inherits
        """
        let graph = try XCTUnwrap(MarkdownClassDiagram.parse(source))
        XCTAssertEqual(graph.relations[0].leftCardinality, "1")
        XCTAssertEqual(graph.relations[0].rightCardinality, "many")
        XCTAssertEqual(graph.relations[0].label, "inherits")
        let layout = MarkdownClassDiagramLayout(diagram: graph)
        XCTAssertEqual(layout.edges.count, 1)
        XCTAssertEqual(layout.edges[0].points.count, 2, "adjacent Animal/Duck must keep the straight gap, not a side lane")
        let animal = try XCTUnwrap(layout.boxes.first(where: { $0.id == "Animal" })?.rect)
        let duck = try XCTUnwrap(layout.boxes.first(where: { $0.id == "Duck" })?.rect)
        XCTAssertGreaterThan(duck.minY, animal.maxY)
        let gap = duck.minY - animal.maxY
        XCTAssertGreaterThanOrEqual(gap, 88, "screenshot gap of 48pt stacked inherits on many/1")
        let edge = layout.edges[0]
        XCTAssertEqual(edge.leftCardinality.x, animal.midX, accuracy: 0.5)
        XCTAssertEqual(edge.rightCardinality.x, duck.midX, accuracy: 0.5)
        XCTAssertGreaterThan(edge.leftCardinality.y, animal.maxY + 10)
        XCTAssertLessThan(edge.leftCardinality.y, edge.label.y)
        XCTAssertLessThan(edge.label.y, edge.rightCardinality.y)
        XCTAssertLessThan(edge.rightCardinality.y, duck.minY - 10)
        let leftBox = MarkdownEntityAnnotation.size("1")
        let rightBox = MarkdownEntityAnnotation.size("many")
        let labelBox = MarkdownEntityAnnotation.size("inherits")
        XCTAssertFalse(annotationRect(edge.leftCardinality, leftBox).intersects(annotationRect(edge.label, labelBox)))
        XCTAssertFalse(annotationRect(edge.rightCardinality, rightBox).intersects(annotationRect(edge.label, labelBox)))
        XCTAssertFalse(annotationRect(edge.leftCardinality, leftBox).intersects(annotationRect(edge.rightCardinality, rightBox)))
        XCTAssertGreaterThan(abs(edge.label.x - animal.midX), 8, "label sits beside the stroke so it cannot paint over 1/many")
        try assertEntityBounds(size: layout.size, boxes: layout.boxes.map(\.rect), edges: layout.edges.map {
            (points: $0.points, left: $0.leftCardinality, right: $0.rightCardinality, label: $0.label)
        })
        let scaled = MarkdownClassDiagramLayout(diagram: graph, scale: 2)
        XCTAssertGreaterThanOrEqual(scaled.boxes[1].rect.minY - scaled.boxes[0].rect.maxY, 176)
        XCTAssertFalse(
            annotationRect(scaled.edges[0].label, MarkdownEntityAnnotation.size("inherits", scale: 2))
                .intersects(annotationRect(scaled.edges[0].rightCardinality, MarkdownEntityAnnotation.size("many", scale: 2)))
        )
    }

    func testClassRoutedAndParallelAnnotationsStayClearWithoutChangingLanes() throws {
        let looping = try XCTUnwrap(MarkdownClassDiagram.parse("classDiagram\nclass A\nA \"1\" --> \"many\" A : loop"))
        let loopLayout = MarkdownClassDiagramLayout(diagram: looping)
        XCTAssertEqual(loopLayout.edges.count, 1)
        XCTAssertEqual(loopLayout.edges[0].points.count, 4)
        XCTAssertGreaterThan(loopLayout.edges[0].points[1].x, loopLayout.boxes[0].rect.maxX)
        XCTAssertGreaterThan(loopLayout.size.width, loopLayout.boxes[0].rect.maxX + 16)
        try assertAnnotationClearance(
            edge: loopLayout.edges[0],
            left: "1", right: "many", label: "loop"
        )
        try assertEntityBounds(size: loopLayout.size, boxes: loopLayout.boxes.map(\.rect), edges: loopLayout.edges.map {
            (points: $0.points, left: $0.leftCardinality, right: $0.rightCardinality, label: $0.label)
        })

        let skip = try XCTUnwrap(MarkdownClassDiagram.parse("classDiagram\nclass A\nclass B\nclass C\nA \"1\" --> \"many\" C : skip"))
        let skipLayout = MarkdownClassDiagramLayout(diagram: skip)
        XCTAssertEqual(skipLayout.edges[0].points.count, 4)
        let columnRight = skipLayout.boxes.map(\.rect.maxX).max() ?? 0
        XCTAssertGreaterThan(skipLayout.edges[0].points[1].x, columnRight)
        XCTAssertFalse(skipLayout.boxes[1].rect.insetBy(dx: 1, dy: 1).contains(skipLayout.edges[0].label))
        try assertAnnotationClearance(edge: skipLayout.edges[0], left: "1", right: "many", label: "skip")
        try assertEntityBounds(size: skipLayout.size, boxes: skipLayout.boxes.map(\.rect), edges: skipLayout.edges.map {
            (points: $0.points, left: $0.leftCardinality, right: $0.rightCardinality, label: $0.label)
        })

        let row = try XCTUnwrap(MarkdownClassDiagram.parse("classDiagram\ndirection LR\nclass A\nclass B\nA \"1\" --> \"many\" B : owns"))
        let rowLayout = MarkdownClassDiagramLayout(diagram: row)
        XCTAssertEqual(rowLayout.edges[0].points.count, 2)
        XCTAssertEqual(rowLayout.edges[0].leftCardinality.y, rowLayout.boxes[0].rect.midY, accuracy: 0.5)
        XCTAssertEqual(rowLayout.edges[0].rightCardinality.y, rowLayout.boxes[1].rect.midY, accuracy: 0.5)
        XCTAssertGreaterThanOrEqual(rowLayout.boxes[1].rect.minX - rowLayout.boxes[0].rect.maxX, 88)
        try assertAnnotationClearance(edge: rowLayout.edges[0], left: "1", right: "many", label: "owns")

        let parallel = try XCTUnwrap(MarkdownClassDiagram.parse("classDiagram\nclass A\nclass B\nA \"1\" --> \"many\" B : first\nA \"1\" --> \"many\" B : second"))
        let parallelLayout = MarkdownClassDiagramLayout(diagram: parallel)
        XCTAssertEqual(parallelLayout.edges.count, 2)
        XCTAssertEqual(parallelLayout.edges[0].points.count, 2)
        XCTAssertEqual(parallelLayout.edges[1].points.count, 2)
        XCTAssertGreaterThan(hypot(parallelLayout.edges[0].label.x - parallelLayout.edges[1].label.x,
                                   parallelLayout.edges[0].label.y - parallelLayout.edges[1].label.y), 10)
        try assertAnnotationClearance(edge: parallelLayout.edges[0], left: "1", right: "many", label: "first")
        try assertAnnotationClearance(edge: parallelLayout.edges[1], left: "1", right: "many", label: "second")
        let firstLabel = annotationRect(parallelLayout.edges[0].label, MarkdownEntityAnnotation.size("first"))
        let secondLabel = annotationRect(parallelLayout.edges[1].label, MarkdownEntityAnnotation.size("second"))
        XCTAssertFalse(firstLabel.intersects(secondLabel))
        try assertEntityBounds(size: parallelLayout.size, boxes: parallelLayout.boxes.map(\.rect), edges: parallelLayout.edges.map {
            (points: $0.points, left: $0.leftCardinality, right: $0.rightCardinality, label: $0.label)
        })
    }

    func testParallelEdgesKeepDistinctLabelsAndAllRelations() throws {
        let graph = try XCTUnwrap(MarkdownClassDiagram.parse("classDiagram\nclass A\nclass B\nA --> B : first\nA --> B : second"))
        XCTAssertEqual(graph.relations.map(\.label), ["first", "second"])
        XCTAssertEqual(graph.relations.map(\.token), ["-->", "-->"])
        let layout = MarkdownClassDiagramLayout(diagram: graph)
        XCTAssertEqual(layout.edges.count, graph.relations.count)
        XCTAssertNotEqual(layout.edges[0].label, layout.edges[1].label)
        XCTAssertGreaterThan(hypot(layout.edges[0].label.x - layout.edges[1].label.x,
                                   layout.edges[0].label.y - layout.edges[1].label.y), 10)
        try assertEntityBounds(size: layout.size, boxes: layout.boxes.map(\.rect), edges: layout.edges.map {
            (points: $0.points, left: $0.leftCardinality, right: $0.rightCardinality, label: $0.label)
        })
        let er = try XCTUnwrap(MarkdownERDiagram.parse("erDiagram\nA ||--|| B : first\nA }o--o{ B : second"))
        XCTAssertEqual(er.relations.map(\.leftCardinality), [.exactlyOne, .zeroOrMore])
        XCTAssertEqual(er.relations.map(\.rightCardinality), [.exactlyOne, .zeroOrMore])
        let erLayout = MarkdownERDiagramLayout(diagram: er)
        XCTAssertEqual(erLayout.edges.count, er.relations.count)
        XCTAssertNotEqual(erLayout.edges[0].label, erLayout.edges[1].label)
        try assertEntityBounds(size: erLayout.size, boxes: erLayout.boxes.map(\.rect), edges: erLayout.edges.map {
            (points: $0.points, left: $0.leftCardinality, right: $0.rightCardinality, label: $0.label)
        })
    }

    private func assertEntityBounds(
        size: CGSize,
        boxes: [CGRect],
        edges: [(points: [CGPoint], left: CGPoint, right: CGPoint, label: CGPoint)],
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws {
        XCTAssertTrue(size.width.isFinite && size.height.isFinite, file: file, line: line)
        XCTAssertLessThanOrEqual(size.width, 8_192, file: file, line: line)
        XCTAssertLessThanOrEqual(size.height, 8_192, file: file, line: line)
        func point(_ p: CGPoint) {
            XCTAssertTrue(p.x.isFinite && p.y.isFinite, file: file, line: line)
            XCTAssertGreaterThanOrEqual(p.x, 0, file: file, line: line)
            XCTAssertGreaterThanOrEqual(p.y, 0, file: file, line: line)
            XCTAssertLessThanOrEqual(p.x, size.width, file: file, line: line)
            XCTAssertLessThanOrEqual(p.y, size.height, file: file, line: line)
        }
        for box in boxes {
            point(CGPoint(x: box.minX, y: box.minY))
            point(CGPoint(x: box.maxX, y: box.maxY))
        }
        for edge in edges {
            XCTAssertGreaterThanOrEqual(edge.points.count, 2, file: file, line: line)
            for item in edge.points + [edge.left, edge.right, edge.label] { point(item) }
        }
    }

    private func annotationRect(_ point: CGPoint, _ size: CGSize) -> CGRect {
        CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height)
    }

    private func assertAnnotationClearance(
        edge: MarkdownClassDiagramLayout.EdgeGeometry,
        left: String,
        right: String,
        label: String,
        scale: CGFloat = 1,
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws {
        let leftBox = annotationRect(edge.leftCardinality, MarkdownEntityAnnotation.size(left, scale: scale))
        let rightBox = annotationRect(edge.rightCardinality, MarkdownEntityAnnotation.size(right, scale: scale))
        let labelBox = annotationRect(edge.label, MarkdownEntityAnnotation.size(label, scale: scale))
        XCTAssertFalse(leftBox.intersects(labelBox), file: file, line: line)
        XCTAssertFalse(rightBox.intersects(labelBox), file: file, line: line)
        XCTAssertFalse(leftBox.intersects(rightBox), file: file, line: line)
    }
}
