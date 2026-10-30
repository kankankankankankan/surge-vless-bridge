# Changelog

## Unreleased

## [1.6.3] - 2026-10-31

### Fixed

- Import VLESS nodes from Clash/Mihomo YAML or JSON, including Base64-encoded configurations, while retaining existing link subscriptions.
- Preserve TLS/Reality, ALPN, WS early data, IPv6, and names; map HTTP Upgrade using Mihomo's WS options.
- Report safe per-source diagnostics, unsupported transport options, and provider-only configurations without logging credentials or response bodies.

## [1.6.1] - 2026-10-31

### Added

- Expand first launch into a four-step setup wizard covering core installation, named subscriptions and direct nodes, Surge settings, review, and the initial sync.
- Allow configured users to reopen the same wizard from settings with existing values prefilled.

### Fixed

- Avoid running a premature sync when Mihomo is selected before sources and the Surge profile have been configured.
- Keep wizard footer actions visible at the minimum window size while only the form content scrolls.

## [1.6.0] - 2026-10-24

### Added

- Build and verify native Intel x86_64 and Apple Silicon arm64 DMGs with GitHub Actions, then upload each architecture with its SHA256 checksum.
- Publish verified dual-architecture DMGs and checksums to GitHub Releases after a matching version tag build succeeds.
- Add a Mihomo gateway runtime backed by one background process and one loopback SOCKS5 listener per node.
- Add runtime selection, Mihomo install/update/rollback, and LaunchAgent controls to desktop settings.
- Route environment diagnostics and repair actions through the selected runtime.
- Persist the local Mihomo controller secret once with private file permissions.
- Keep shared generation settings visible in both runtimes and scope DNS resolution plus custom connection timeout to External.
- Remove the ignored Mihomo VLESS `connect-timeout` key after validation against official v1.19.33 source and binary.
- Route CLI, desktop, and scheduled sync operations through the configured runtime.
- Require an explicit runtime choice on first launch and provide an in-app runtime switch later.
- Show download, verification, extraction, installation, and validation progress for managed core installs.
- Support custom subscription names and custom hourly schedule intervals.
- Add recoverable startup loading with a timeout and a visible retry action.

### Fixed

- Require a manual workflow run and the `npm-publish` environment before publishing to npm, preventing fork pushes from creating failed publish runs.
- Keep the desktop loading screen from spinning forever when initial state loading fails or stalls.
- Keep the top-bar preview and sync labels and icons vertically centered.
- Improve narrow-window, schedule, Mihomo settings, preview, and installation-progress layouts.
- Continue processing usable subscriptions when another source is empty or fails, without exposing private URLs.

## [1.5.19] - 2026-10-24

### Fixed

- Stop only this application's managed sing-box processes before automatically reloading Surge, preventing stale processes from keeping local node ports occupied after a sync, rebuild, restore, or cleanup.

## [1.5.18] - 2026-10-24

### Fixed

- Package desktop renderer assets from stable source paths so direct Electron Builder runs cannot produce a blank window.
- Show a readable installation error when the renderer entry file cannot be loaded.
- Apply a reproducible ad hoc signature to both macOS architecture builds.

## [1.5.17] - 2026-10-23

### Added

- Add optional sing-box TCP Fast Open and custom remote connection timeout controls.
- Add an optional Surge UDP connectivity test target for UDP-enabled external proxies.

### Fixed

- Keep update preview footer actions above the macOS Dock in short or scaled windows.

## [1.5.16] - 2026-10-23

### Added

- Add an optional desktop and config switch for Surge External Policy UDP relay.
- Keep `udp-relay=true` during subscription sync and local profile rebuilds when enabled.

### Changed

- Leave UDP relay disabled for existing configurations unless the user enables it.

## [1.5.15] - 2026-10-23

### Added

- Show the installed sing-box version, latest stable release, installation source, and update state in desktop settings.
- Validate every existing managed node config before replacing the managed binary and keep the previous version available for rollback.

### Changed

- Use `brew upgrade sing-box` for existing Homebrew installations and `brew install sing-box` for first-time installs.
- Add a regression guard that keeps sing-box-only options out of Surge external policy lines.

### Fixed

- Parse the leading `v` in official GitHub release tags so update checks also show the latest version before sing-box is installed.

## [1.5.14] - 2026-10-23

### Fixed

- Place the custom schedule interval on its own full-width row so the preset selector, value, unit, and help text remain aligned at the minimum window width.

## [1.5.13] - 2026-10-23

### Added

- Add per-policy-group `auto`, `merge`, and `reference` membership modes.
- Show complete policy group lines before and after each change in the update preview.

### Changed

- Automatically merge VLESS into groups that use `smart`, `include-other-group`, or `policy-regex-filter`.
- Reject direct policy-group references in Surge smart groups before writing the profile.

## [1.5.12] - 2026-10-23

### Changed

- Show policy groups that already contain VLESS as selected while keeping them editable.
- Unchecking an included group removes VLESS during the next sync and preserves its other members and parameters.
- Display included, pending addition, pending removal, and excluded states in the policy group list.

## [1.5.11] - 2026-10-23

### Fixed

- Add VLESS to `smart` groups through `include-other-group`, matching Surge smart-group syntax.
- Migrate invalid direct VLESS members and remove included references during managed cleanup.

## [1.5.10] - 2026-10-23

### Fixed

- Keep the update preview within narrow or scaled windows so its close control, all metrics, local port column, and footer actions remain visible.
- Truncate long profile paths and policy-group lists while preserving their full values in hover titles.

## [1.5.9] - 2026-10-23

### Changed

- Add select-all, clear, and live selection counts to the policy-group checklist.
- Refresh policy groups from the currently entered Surge profile path while preserving unsaved selections.
- Replace workflow numbering and the generic app mark with task-specific icons.
- Keep the settings save action visible while scrolling long forms.

## [1.5.8] - 2026-10-23

### Changed

- Read policy groups from the selected Surge profile and display them as desktop checkboxes.
- Mark groups that already contain VLESS while leaving their existing membership unchanged.
- Hide the known Electron parent-process inspection warning from the displayed scheduler log while preserving sync output and other errors.

## [1.5.7] - 2026-10-23

### Added

- Add the generated VLESS policy group to multiple existing Surge policy groups from desktop settings or configuration.
- Show target policy groups in previews and remove managed references during cleanup.

### Changed

- Preserve target group types, members, parameters, and inline requirement comments while deduplicating VLESS references.
- Reject missing target groups before changing the Surge profile or generated node files.

[中文更新日志](./CHANGELOG.zh-CN.md)

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.6] - 2026-10-23

### Changed

- The sidebar now displays the installed application version.
- The schedule view now states that macOS continues running enabled jobs after the app exits.

## [1.5.5] - 2026-10-23

### Added

- Added manual history clearing and old-backup cleanup while preserving the latest backup.

### Fixed

- Reworked the app icon with a transparent canvas and macOS-style rounded silhouette for the Dock.

## [1.5.4] - 2026-10-23

### Added

- Interval schedules accept any whole number from 1 to 168 hours while keeping the common presets.

### Changed

- The schedule view now uses a clearer next-run status row with consistent icon alignment and no
  nested bordered surface.
- Settings now call out that address resolution applies only to VLESS node server hostnames and does
  not affect domains visited through the proxy.

## [1.5.3] - 2026-10-23

### Fixed

- The macOS GUI now checks its managed install directory, `~/.local/bin`, `/opt/homebrew/bin`, and
  `/usr/local/bin`, so a terminal-installed `sing-box` is found even when the GUI has no shell PATH.
- When `sing-box` is missing, settings now show the same managed path used by the official installer.

## [1.5.1] - 2026-08-18

### Fixed

- Nodes on a literal IPv6 address now work. URL parsing returns such a host bracketed
  (`[2001:db8::1]`), and that value reached both the generated sing-box config and the resolver.
  sing-box reads `server` as an IP or a domain, and a bracketed value parses as neither, so it was
  treated as a hostname that never resolved — the node started but no request ever got through.
  `sing-box check` accepts the field as a plain string, so nothing flagged it. The brackets are now
  stripped where the link is parsed, which also fixes the malformed `addresses=` written into the
  Surge external proxy line.

### Upgrading

- Node configs generated before this release still hold the bracketed `server`, and `rebuild` reuses
  them as they are. If you use IPv6 nodes, run a full `sync` once to regenerate them.

## [1.5.0] - 2026-08-17

### Added

- `init` is interactive. It asks for the subscription URL — a raw `vless://` link is accepted too, and
  is stored under `vlessNodes` — then lets you pick a Surge profile from a list showing each one's
  last modified time, navigated with ↑/↓ or the number keys. Enter skips the URL, Esc skips the
  profile, and anything skipped can still be filled in by hand afterwards.
- `--no-input` writes the config template without asking anything. `init` also detects a missing TTY
  on its own, so it never blocks under an agent, in CI, or behind a pipe.
- [docs/agent-setup.md](./docs/agent-setup.md), a guide for driving the CLI with an AI agent: command
  order, config path rules, how to read `doctor`, and which commands must not run unconfirmed.

### Changed

- `init` reports what it recorded — the node source with its credentials redacted, and the chosen
  Surge profile — followed by the next command to run.
- When no Surge profile is detected, `init` explains where to find the path in Surge and accepts the
  file dragged in from Finder, unescaping it rather than storing the shell-escaped string.
- Values passed to `init` are trimmed before they are written, so a padded `--subscription-url` no
  longer leaves whitespace in the config file.
- `init` checks for an existing config before it asks anything, instead of collecting answers and then
  refusing to overwrite.

## [1.4.0] - 2026-08-13

### Added

- `sync --dry-run` reports the nodes, ports and profile changes a sync would produce without writing
  anything.
- `clean` removes the generated node configs and the managed block and policy group from the Surge
  profile, leaving everything else intact. The profile is backed up first.
- The Surge profile is reloaded automatically after `sync`, `rebuild` and `restore`, through the Surge
  HTTP API (`http-api` in `[General]`) or `surge-cli` when available. Disable with `--no-reload` or
  `"autoReload": false`.
- `backupKeep` (default `20`) prunes old profile backups, which previously accumulated forever.
- `help` shows the repository URL and where to report issues.

### Changed

- Unknown flags, unknown commands, missing flag values and non-numeric numeric flags are now errors.
  A mistyped `--group-nmae` used to be ignored, so the command appeared to succeed while doing
  something else.
- `--flag=value` is accepted alongside `--flag value`.
- The help text documents only the user-facing config path; the development path is no longer listed.

### Fixed

- `doctor` exits non-zero when a check fails, so scripts and CI can rely on it.
- `doctor` verifies that `outputDir` and `backupDir` exist rather than always reporting OK, and reports
  a missing directory before the first sync as a warning rather than a failure.
- `doctor` reports the local port range in use and whether the Surge HTTP API is reachable.

## [1.3.1] - 2026-08-13

### Fixed

- Generated configs no longer set `tls.record_fragment`. The option only exists from sing-box 1.12 and
  was always written with its default value, so on older builds — including the 1.11.x releases still
  used on macOS 10.15 — sing-box rejected every generated config with `json: unknown field`, exited
  immediately, and Surge reported `External Proxy Process Terminated`
  ([#5](https://github.com/chen86860/surge-vless-bridge/issues/5)).

## [1.3.0] - 2026-08-13

### Added

- `sync` generates and validates every node in a staging directory before touching anything, so a
  failure part-way through leaves both the Surge profile and the previous node configs untouched
  (adapted from [#7](https://github.com/chen86860/surge-vless-bridge/pull/7), thanks to
  [@MapleGu](https://github.com/MapleGu)).
- Node configs produced by a sync are recorded in `manifest.json`, and `rebuild` reads it instead of
  globbing the output directory. Installs without a manifest keep working through a glob fallback.
- Generated configs are validated with `sing-box check`, capped at 8 parallel processes. This is a
  structural check: it rejects malformed JSON and unknown outbound types, but accepts an outbound with
  missing or nonsensical fields, so it is not a connectivity test.
- A `node --test` suite of 26 tests, run in CI on Node 20, 22 and 24.

### Fixed

- `rebuild` no longer resurrects nodes that have been removed from the subscription. Node configs left
  behind by a shrinking subscription are now deleted during `sync`.
- Subscriptions are no longer Base64-decoded blindly. A plain-text list is detected and passed through,
  the URL-safe alphabet is supported, and an unrecognised response — an HTML error page from an expired
  account, for instance — is reported instead of decoding into mojibake and yielding zero nodes.
- The subscription request times out after 15 seconds instead of hanging `sync` indefinitely.
- Reality nodes without a public key are rejected at parse time. sing-box starts without one but every
  handshake fails, which surfaces in Surge as a proxy that dies on each request.
- `sync` refuses to update the profile when no configured source yields a VLESS node, and fails early
  with a clear message when the Surge profile or the sing-box binary is missing.
- CRLF line endings and duplicate links within a single subscription are handled.

## [1.2.0] - 2026-08-13

### Added

- `subscriptionUrls` merges several VLESS subscriptions into a single Surge policy group
  ([#4](https://github.com/chen86860/surge-vless-bridge/pull/4), thanks to
  [@SKYhuangjing](https://github.com/SKYhuangjing)).
- `vlessNodes` accepts raw `vless://` links in the config, for nodes that are not part of any
  subscription.
- Duplicate policy names are deduplicated with a numeric suffix (`HK 01 2`), so nodes that share a name
  across providers no longer trigger Surge's `Policy already exists` error.
- Generated external proxy lines left outside the `# vless start` / `# vless end` block by older
  versions are cleaned up during `sync`.

### Changed

- `subscriptionUrl` and `subscriptionUrls` are merged and deduplicated instead of the latter shadowing
  the former, with `subscriptionUrl` fetched first so existing node order and local ports stay stable.
  Adding a second provider to an existing config no longer silently drops the original subscription.
- The `doctor` check `subscriptionUrl` is now `nodeSources` and reports how many subscription URLs and
  direct nodes are configured.

### Fixed

- A failing subscription reports which one failed (`Subscription 2 of 3`) and names the provider by
  origin, without leaking the token carried in the URL path or query.
- A subscription that returns no VLESS nodes logs a warning instead of contributing nothing silently.

## [1.1.0] - 2026-08-13

### Changed

- **`addressResolver.strategy` now defaults to `doh` instead of `system`.** With Surge's enhanced mode
  enabled, the system resolver answers with fake IPs in `198.18.0.0/15`, which were pinned into
  `addresses=` and left the generated nodes unusable. DoH bypasses the system resolver, so `sync` no
  longer requires turning enhanced mode off ([#3](https://github.com/chen86860/surge-vless-bridge/issues/3)).
- Address resolution falls back across resolvers. Every strategy except `off` now tries the remaining
  resolvers when its own result is empty or contains only fake IPs (`doh` → `dns` → `system`, and the
  equivalent chain for each configured strategy). A single failing resolver no longer aborts resolution
  for that node.
- IPv4 is preferred when a proxy server resolves to several addresses. Surge accepts only one value in
  `addresses=`, and A/AAAA records arrived in an unstable order, so the written address could be an IPv6
  one that IPv4-only networks cannot reach. IPv6 is still written when no A record exists.

### Fixed

- A resolver error is now logged per resolver and skipped, instead of aborting the whole lookup and
  silently omitting `addresses=`. A node that cannot be resolved at all reports an explicit error.

## [1.0.8] - 2026-06-13

### Added

- `surge-vless-bridge --version` to print the installed version.

## [1.0.7] - 2026-06-13

### Fixed

- The publish workflow now targets the `master` branch explicitly.

## [1.0.6] - 2026-04-15

### Fixed

- Surge fake IP addresses (`198.18.0.0/15`) are filtered before being written into `addresses=`, and
  `addressResolver` gained the `filterSurgeFakeIp`, `dohEndpoint`, and `dnsServers` options
  ([#1](https://github.com/chen86860/surge-vless-bridge/pull/1)).
- `outputDir` defaults to `~/.config/surge-vless-bridge/nodes`.

## [1.0.1] - [1.0.5] - 2026-04-14 / 2026-04-15

Initial public releases: `init` / `sync` / `rebuild` / `restore` / `doctor` commands, VLESS
subscription parsing, per-node sing-box config generation, Surge profile backup, and npm publishing.

[1.5.0]: https://github.com/chen86860/surge-vless-bridge/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/chen86860/surge-vless-bridge/compare/v1.3.1...v1.4.0
[1.3.1]: https://github.com/chen86860/surge-vless-bridge/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/chen86860/surge-vless-bridge/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/chen86860/surge-vless-bridge/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/chen86860/surge-vless-bridge/compare/v1.0.6...v1.1.0
[1.0.8]: https://github.com/chen86860/surge-vless-bridge/compare/v1.0.6...v1.0.8
[1.0.7]: https://github.com/chen86860/surge-vless-bridge/compare/v1.0.6...v1.0.7
[1.0.6]: https://github.com/chen86860/surge-vless-bridge/compare/v1.0.5...v1.0.6
