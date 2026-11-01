import Foundation
import MichiCore

enum ConnectionStoreAppHook {
    static func install() {
        #if DEBUG
        ConnectionStoreTesting.uiTestingFactory = {
            let config = URLSessionConfiguration.ephemeral
            config.protocolClasses = [FixtureURLProtocol.self]
            let api = MichiAPI(baseURL: FixtureURLProtocol.baseURL, session: URLSession(configuration: config))
            let profile = ConnectionProfile(
                id: "fixture",
                name: "Preview Mac",
                address: FixtureURLProtocol.baseURL.absoluteString
            )
            return (api, profile)
        }
        #endif
    }
}
