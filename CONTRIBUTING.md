# Contributing

Thanks for helping improve Satelita. Bug reports, focused fixes, and small,
well-explained features are welcome.

## Before you start

Open an issue before beginning a substantial change so the approach can be
discussed. For bugs, include the operating system, Deno version, the RTL-SDR
model, the command you ran, and the complete error output.

Use conventional commit messages such as `fix: handle a disconnected dongle` or
`docs: clarify the native preview workflow`.

## Development setup

Install Deno 2.9 or newer, then run:

```bash
deno install
deno task dev
```

The browser development server is the fastest option for interface work. Use
`deno task preview` when a change needs the native window or radio tooling.

The external `rtl_fm`, `rtl_test`, `sox`, and `satdump` commands and an RTL-SDR
dongle are only required for end-to-end capture testing.

## Verification

Run the same checks as CI before opening a pull request:

```bash
deno task test
deno task build
```

Changes to capture, device detection, decoding, or packaging should also be
tested manually with the relevant hardware or native package. State what you
tested in the pull-request description.

## Known development warning

The development server may log a server-rendering error from Base UI's Select
component because Deno's npm layout provides a nested React copy. The client
recovers and the production build is unaffected. A failing production build, an
unusable interface, or any other error should not be dismissed as this known
warning.

Keep the `dev` and `build` tasks as plain web-framework commands. `deno desktop`
detects and invokes those tasks itself, so calling `deno desktop` from either
task creates a recursive build loop. The native packaging task is named `bundle`
for that reason.

## Pull requests

- Keep the change focused and explain user-visible behavior.
- Add or update tests when behavior changes.
- Update documentation when commands, dependencies, or limitations change.
- Do not commit generated packages, recordings, local settings, or secrets.
