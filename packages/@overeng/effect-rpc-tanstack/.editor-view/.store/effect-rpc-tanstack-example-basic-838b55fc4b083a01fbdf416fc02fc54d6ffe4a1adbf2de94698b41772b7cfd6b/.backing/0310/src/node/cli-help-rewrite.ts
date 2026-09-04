/**
 * Rewrites `help <subcmd>` → `<subcmd> --help` for CLIs that lack a native `help` subcommand.
 * Input and output are pure user args (no node/script positions).
 */
export const rewriteHelpSubcommand = (args: readonly string[]): string[] => {
  const [head, ...rest] = args
  return head === 'help' ? [...rest, '--help'] : [...args]
}
