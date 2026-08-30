# homeESS

[Hier klicken für die deutsche Fassung.](README_de.md)

homeESS is a self-hosted energy management server for photovoltaic systems,
batteries and controllable electrical loads. It reads device values through
MQTT or isolated adapters, calculates the current energy state and controls
loads through a responsive web interface.

The server is built with Node.js and SQLite and is intended to run continuously
on small, energy-efficient Linux systems. A detailed product overview is
available in [FEATURES.md](FEATURES.md).

## Hardware requirements

| Resource | Minimum | Recommended |
|---|---:|---:|
| CPU | 1 x86 or ARM core | 2 cores |
| Memory | 512 MB RAM | 1 GB RAM |
| Storage | 4 GB | 8 GB SSD or eMMC |
| Network | Wi-Fi | Wired Ethernet |

Tested deployment targets include Raspberry Pi 4/5, small x86 mini PCs and
virtual machines or LXC containers. A minimal Debian installation is sufficient.

## Software requirements

- Debian, Ubuntu, Raspberry Pi OS or another Debian-based distribution
- `systemd` and `apt`
- Node.js 20.17 or newer; the installer adds a suitable Node.js version when required
- An MQTT broker is optional for the initial start

## Installation

On a minimal system, install `curl` and `sudo` first:

```bash
apt update
apt install -y curl sudo
```

Install homeESS with one command:

```bash
curl -fsSL https://raw.githubusercontent.com/mykaefer/home-ess/main/install.sh | sudo bash
```

The installer places the application in `/opt/home-ess`, stores persistent data
in `/var/lib/home-ess`, installs the `home-ess.service` systemd unit and starts
the web interface on port `3000`.

Open `http://<server-ip>:3000` and sign in with the initial account
`admin` / `admin`. Change this password immediately after the first login.

### Updating an existing installation

Run the same command again. Application code and installed official adapters
are updated while the database, identities, uploaded adapters and the explicit
adapter selection remain intact:

```bash
curl -fsSL https://raw.githubusercontent.com/mykaefer/home-ess/main/install.sh | sudo bash
```

Adapters deliberately removed in the web interface stay removed. To explicitly
restore every official adapter from the repository, use `--all`:

```bash
curl -fsSL https://raw.githubusercontent.com/mykaefer/home-ess/main/install.sh | sudo bash -s -- --all
```

The built-in update function follows the stored adapter selection and never
performs the `--all` operation.

## License

The homeESS server is licensed under GNU Affero General Public License v3.0
(`AGPL-3.0-only`). The Android app, the homeESS Remote license and the essrelay
service are a separate proprietary add-on.
