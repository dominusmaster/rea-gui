<p align="center"><img src="brand/logo-dark.png" alt="REA GUI" width="480"></p>

# REA GUI

A visual interface for [REA: Reverse Engineer Anything](https://github.com/morluto/rea).
Point it at an app and it tells you, in plain language, who signed it, what it can
access, how it's built and what it exposes. Nothing you analyze is executed.

Run it on your own computer, or deploy it to a server and use it from a browser.

> REA GUI is an unofficial, community-built interface. It is not affiliated with or
> endorsed by the REA project. REA itself is installed as a dependency (`rea-agents`).

## What it does

- **Guided analysis.** Paste a path, pick an installed app, or (on a server) upload a
  file. REA GUI works out what it is and runs the right REA checks in order:

  | You give it | It checks |
  |---|---|
  | Electron app (Slack, Notion, …) | Code signature and entitlements, Electron hardening (fuses), what's inside the bundle, JavaScript code (windows, preload scripts, IPC channels, APIs exposed to web pages) |
  | Mac app | Code signature and entitlements, main executable, what's inside the bundle |
  | Android `.apk` | What's inside (manifest, DEX, native libraries, signing), Flutter, manifest and permissions |
  | iOS `.ipa` | What's inside (bundles, executables, frameworks, signing) |
  | `app.asar` or a JavaScript project | JavaScript code |
  | Windows `.exe`/`.dll`, Mach-O and Linux binaries, WebAssembly, SQLite | The matching REA inspections |

  Each analysis opens with **At a glance** and the points worth a closer look, then a
  card per check with findings, key numbers, drill-downs and REA's full evidence.
  Analyses are saved, so they reopen later without running again.
- **Chat.** Ask questions about an app; the assistant finds and runs REA's tools and
  asks before anything that changes state. Works with Anthropic (Claude), OpenAI,
  Google Gemini, xAI (Grok) and DeepSeek using your own API key, or any tool-capable
  model on [OpenRouter](https://openrouter.ai/).
- **Tool library.** All of REA's 200+ tools, each with a form generated from its
  schema, examples, live progress and cancellation.

## Run it on your computer

Needs Node.js 22.19+, 24.11+ or 26+.

```bash
git clone https://github.com/dominusmaster/rea-gui.git
cd rea-gui/rea-gui
npm install
npm start
```

Then open <http://localhost:4517/>. REA GUI listens only on `127.0.0.1`, so nothing
else on your network can reach it.

## Deploy it to a server

On a server REA GUI asks for a password, and files are uploaded from your browser
instead of picked from disk. It refuses to listen on a public address without
`REA_GUI_PASSWORD`.

### Docker (recommended)

```bash
git clone https://github.com/dominusmaster/rea-gui.git
cd rea-gui/rea-gui
echo "REA_GUI_PASSWORD=$(openssl rand -base64 24)" > .env   # keep this; it's your sign-in
docker compose up -d
```

Open `http://<server>:4517/` and sign in with the password from `.env`. Saved analyses
and uploads live in the `rea-gui-data` volume.

Without Compose:

```bash
docker build -t rea-gui .
docker run -d -p 4517:4517 -e REA_GUI_PASSWORD=change-me -v rea-gui-data:/data rea-gui
```

### Hosting platforms (Render, Railway, Fly.io, …)

Point the platform at this repository with **`rea-gui`** as the root directory and the
included `Dockerfile`. Set `REA_GUI_PASSWORD`, give it a persistent disk at `/data`,
and use `/healthz` as the health check. These platforms provide HTTPS for you.

### Plain Node

```bash
REA_GUI_PASSWORD=change-me npm start -- --host 0.0.0.0 --no-open
```

### Use HTTPS

Your password and session travel with every request, so put HTTPS in front of REA GUI
before exposing it to the internet. For example, with [Caddy](https://caddyserver.com/):

```
rea.example.com {
    reverse_proxy 127.0.0.1:4517
}
```

Behind a proxy, also set `REA_GUI_TRUST_PROXY=1` so sign-in limits apply per visitor.

## Settings

| Variable | What it does |
|---|---|
| `REA_GUI_PASSWORD` | Sign-in password. Required to listen on anything but `127.0.0.1`. |
| `REA_GUI_HOST`, `PORT` | Address and port to listen on (default `127.0.0.1:4517`). Also `--host` and `--port`. |
| `REA_GUI_DATA_DIR` | Where saved analyses and uploads are kept (default `~/.rea-gui`; `/data` in Docker). |
| `REA_GUI_MAX_UPLOAD_MB` | Largest upload (default 4096). |
| `REA_GUI_TRUST_PROXY` | Set to `1` behind a reverse proxy. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY` | Chat keys for everyone using this REA GUI, instead of each person entering their own. |
| `REA_BIN`, `REA_NODE` | Use a specific REA (for example, a source checkout) or Node for REA. |

## Chat keys

Open **Chat**, choose a provider (Anthropic, OpenAI, Google Gemini, xAI, DeepSeek or
OpenRouter) and paste your key. Each provider's settings link to where you create one. Keys entered there are stored
in your browser and sent only to your REA GUI server, which uses them to call the
provider. On a shared server, anyone signed in can use keys set in the server's
environment.

## Optional tools

Some checks need software REA doesn't install: jadx for decoded Android manifests,
adb or Frida for devices, Hopper, Ghidra or IDA for native decompilation. They show as
**Needs setup** with what to install, and **What works on this computer** (or
**on this server**) on the home page lists them all. See
[REA's installation docs](https://github.com/morluto/rea). To add them to the Docker
image, extend the `Dockerfile`.

Commercial tools (IDA Pro, Hex-Rays, Hopper, JEB) need your own valid licenses.
REA GUI doesn't include or provide them.

## Security

- **On your computer:** listens on `127.0.0.1` only. Every launch issues a random
  token, and requests addressed to any other host name are refused, so websites
  can't drive your REA.
- **On a server:** everything except the sign-in page and `/healthz` requires the
  password. Sessions use `HttpOnly`, `SameSite=Strict` cookies, and repeated wrong
  passwords are blocked for 15 minutes. Anyone signed in has the same access as REA
  on that machine (reading files, running REA tools), so share the password only with
  people you trust.
- Text from analyzed files is always shown as text, never as HTML.

## Analyze responsibly

Only analyze software you own or have permission to analyze, and follow its license
and the law where you live. Reverse engineering may be restricted by license terms
and by laws on circumventing technical protections.

## Development

REA GUI is written in TypeScript with the same strict settings as REA. `src/bin` and
`src/lib` are the server, `src/web` the browser code; both compile to `dist/`.

```bash
npm install
npm run build      # compile src/ to dist/ (npm start does this first)
npm run typecheck  # type-check the server, browser code and tests
npm test           # type-check, build, then end-to-end tests against a fake REA and fake providers
npm start
```

## License

[MIT](LICENSE). REA is MIT-licensed by its authors; third-party components keep their
own licenses.
