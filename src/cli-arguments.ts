export function assertCliArguments(argv: readonly string[], flags: Readonly<Record<string, "value" | "switch">>): void {
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i], kind = flags[flag];
    if (!kind) throw new TypeError(`Unsupported argument ${flag}. See --help.`);
    if (seen.has(flag)) throw new TypeError(`Duplicate argument ${flag}.`);
    seen.add(flag);
    if (kind === "value") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new TypeError(`${flag} requires a value.`);
    }
  }
}
