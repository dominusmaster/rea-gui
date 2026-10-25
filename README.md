<p align="center"><img src="rea-gui/brand/logo-dark.png" alt="REA GUI" width="480"></p>

# REA GUI

The open-source GUI for [REA: Reverse Engineer Anything](https://github.com/morluto/rea).
Self-host it: run it on your own computer in one command, or deploy it to your own
server with Docker. Nothing you analyze is executed.

```bash
git clone https://github.com/dominusmaster/rea-gui.git
cd rea-gui/rea-gui
npm install && npm start          # on your computer: http://localhost:4517/
# or, on a server:
echo "REA_GUI_PASSWORD=$(openssl rand -base64 24)" > .env && docker compose up -d
```

The app lives in [`rea-gui/`](rea-gui/); see its [README](rea-gui/README.md) for
features, deployment, settings and security.

> Unofficial, community-built; not affiliated with or endorsed by the REA project.

MIT licensed. Only analyze software you own or have permission to analyze.
