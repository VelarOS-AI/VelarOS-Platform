import Foundation

guard let resources = Bundle.main.resourceURL else {
  fputs("Velar Host resources are unavailable.\n", stderr)
  exit(1)
}

let launchScript = resources.appendingPathComponent("Launch Velar Host.command")
let process = Process()
process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
process.arguments = ["-a", "Terminal", launchScript.path]

do {
  try process.run()
  process.waitUntilExit()
  exit(process.terminationStatus)
} catch {
  fputs("Unable to open Terminal: \(error)\n", stderr)
  exit(1)
}
