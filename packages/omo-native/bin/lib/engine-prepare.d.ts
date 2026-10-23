export declare const ENGINE_PREPARED_STAMP: ".omo-engine-prepared"
export declare function prepareInstalledEngine(senpiRoot: string): void
export declare function writeEnginePreparedStamp(senpiRoot: string, omoVersion: string): void
export declare function preparePluginLaunchSpec(options: {
  readonly pluginRoot: string
  readonly report?: (line: string) => void
  readonly io?: Record<string, unknown>
}): void
export declare function ensureEnginePrepared(options: {
  readonly senpiRoot: string
  readonly omoVersion: string
  readonly reinstallCommand: string
  readonly report?: (line: string) => void
}): void
