import Foundation
import PackagePlugin

@main
struct SwiftTermBuildInfoPlugin: BuildToolPlugin {
    func createBuildCommands(context: PluginContext, target: Target) async throws -> [Command] {
        let generator = try context.tool(named: "SwiftTermBuildInfoGenerator")
        let outputDirectory = context.pluginWorkDirectoryURL.appendingPathComponent("Generated")
        let outputFile = outputDirectory.appendingPathComponent("SwiftTermBuildInfo.swift")
        let triggerFile = context.pluginWorkDirectoryURL.appendingPathComponent("build-info-trigger")
        // Never mistake the containing application's Git repository for upstream.
        let fallbackEnvironment = [
            "SWIFTTERM_BUILD_BRANCH": "runweave-vendored",
            "SWIFTTERM_BUILD_TAG": "1.19.0-runweave.1",
            "SWIFTTERM_BUILD_COMMIT": "464df5207fc2432e16c9a23abe538187196daf5f",
            "SWIFTTERM_BUILD_DIRTY": "true"
        ]

        try FileManager.default.createDirectory(
            at: context.pluginWorkDirectoryURL,
            withIntermediateDirectories: true
        )
        try UUID().uuidString.write(to: triggerFile, atomically: true, encoding: .utf8)

        return [
            .buildCommand(
                displayName: "Generate SwiftTerm build information",
                executable: generator.url,
                arguments: [
                    context.package.directoryURL.path,
                    outputFile.path
                ],
                environment: fallbackEnvironment,
                inputFiles: [triggerFile],
                outputFiles: [outputFile]
            )
        ]
    }
}
