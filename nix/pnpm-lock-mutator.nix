{ pkgs }:

# Lockfile mutation ran on a pinned pnpm 11.5.1 because pnpm 11.5.2 through
# 11.14.0 corrupt `hasBin` metadata when `install --fix-lockfile` rewrites
# unchanged package records (pnpm/pnpm#6600). pnpm 12 is outside that window and
# no longer carries the JavaScript `--fix-lockfile` path that lost the field, so
# the repository pin mutates its own lockfile again and the separate pin is
# retired instead of being carried forward.
#
# The mechanism stays: `pnpmLockMutatorPkg` still lets a caller point lock
# mutation at a different pnpm than frozen installs, the module's allowlist
# still refuses an unverified override, and the `pnpm:update` transaction still
# restores the lockfile and fails closed when a retained package record loses
# `hasBin`.
import ./pnpm.nix { inherit pkgs; }
