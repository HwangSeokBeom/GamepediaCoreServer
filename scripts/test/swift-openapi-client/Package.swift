// swift-tools-version: 6.1

import PackageDescription

let package = Package(
    name: "GamePediaProduct22Contract",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .executable(
            name: "ContractSmoke",
            targets: ["ContractSmoke"]
        ),
    ],
    dependencies: [
        .package(
            url: "https://github.com/apple/swift-openapi-generator",
            exact: "1.11.1"
        ),
        .package(
            url: "https://github.com/apple/swift-openapi-runtime",
            exact: "1.12.0"
        ),
    ],
    targets: [
        .executableTarget(
            name: "ContractSmoke",
            dependencies: [
                .product(
                    name: "OpenAPIRuntime",
                    package: "swift-openapi-runtime"
                ),
            ],
            plugins: [
                .plugin(
                    name: "OpenAPIGenerator",
                    package: "swift-openapi-generator"
                ),
            ]
        ),
    ]
)
