<p align="center"><img src="brand/logo-dark.png" alt="REA Studio" width="480"></p>

# REA Studio (rea-gui)

A local browser GUI for [REA: Reverse Engineer Anything](https://github.com/morluto/rea).

```bash
npx rea-gui
```

This opens `http://localhost:4517/`. Paste a path, or click one of your installed
apps, then press **Analyze**. Nothing you analyze is executed.

REA Studio works out what the file is and runs the right checks in order:

| You give it | It checks |
|---|---|
| Electron app (Slack, Notion, …) | Code signature and entitlements, Electron hardening (fuses), what's inside the bundle, JavaScript code (windows, preload scripts, IPC channels, APIs exposed to web pages) |
| Mac app | Code signature and entitlements, main executable, what's inside the bundle |
| Android `.apk` | What's inside (manifest, DEX, native libraries, signing), Flutter, manifest and permissions |
| iOS `.ipa` | What's inside (bundles, executables, frameworks, signing) |
| `app.asar` or a JavaScript project | JavaScript code |
| Windows `.exe`/`.dll`, Mach-O and Linux binaries, WebAssembly, SQLite | The matching REA inspections |

Each analysis page starts with **At a glance**: one line per check, plus the
points worth a closer look (for example, "NODE_OPTIONS is honored, so code can be
injected through the environment"). Each check then has its own card:

- findings in plain language;
- the key numbers;
- **Look closer** buttons that page through the underlying facts, such as IPC
  channels with their source locations, or a binary's linked libraries;
- **Details**, which holds REA's full evidence record.

Checks that need software you haven't installed (jadx, adb, WABT, a decompiler)
are marked **Needs setup** and say what to install. **What works on this Mac**,
on the home page, lists them all.

**Advanced: individual REA tools**, in the sidebar, exposes REA's 200+ tools
directly. Each tool gets a form generated from its input schema, plus examples,
an evidence picker, live progress and cancellation.

### Two designs

The top bar has a **Practical UI design** switch. When it's on (the default), the
interface follows the [Practical UI](https://www.practical-ui.com/) guidelines:
WCAG 2.1 AA contrast, 48px targets, three button weights, sentence case, labels and
hints above fields, and status never shown by colour alone. Switch it off to see
the original design. **What changed** lists every fix, with before and after.

## How it works

`rea-gui` starts `rea mcp` (from the bundled `rea-agents` dependency) as a child
process and talks to it over MCP stdio. The browser UI talks to that bridge over
HTTP on `127.0.0.1`. Each launch issues a random token, and requests with any other
`Host` header are refused, so other websites cannot drive your local REA. All text
taken from analyzed targets is rendered as text, never as HTML.

## Options

```
rea-gui [--port 4517] [--host 127.0.0.1] [--no-open]
REA_BIN=/path/to/rea/scripts/rea.mjs   use a specific REA (for example, a source checkout)
REA_NODE=/path/to/node                 Node used to run REA (22.19+, 24.11+ or 26+)
```

Native analysis (Hopper, Ghidra or IDA) uses the same provider setup as the REA CLI.
See REA's installation docs.

## Development

```bash
npm install
npm run smoke   # end-to-end test against a fake MCP server
npm start
```

## License

MIT
