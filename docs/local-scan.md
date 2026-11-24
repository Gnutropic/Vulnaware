# Local TCP scan on Raspberry Pi OS

This workflow runs the standalone TypeScript CLI directly. It does not start
Next.js, connect to PostgreSQL, or invoke Nmap or Nuclei. It opens one TCP
connection only after the exact literal IP and port pair appears in the
allowlist. The shipped allowlist contains only `127.0.0.1:2222`.

## 1. Install prerequisites

Use a 64-bit Raspberry Pi OS terminal. Node.js 22 is supported on ARM64 and
meets this checkout's Node.js requirement (`>=20.18.1`). Run:

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl git netcat-openbsd python3
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version
npm --version
```

Open a terminal in the checked-out VulnAware repository, then install its
dependencies:

```sh
npm ci
```

No database URL or database server is needed for these commands.

## 2. Start the sample banner server

In terminal 1, from the repository directory, run:

```sh
npx tsx scripts/local-banner-server.ts --host 127.0.0.1 --port 2222 --banner 'OpenSSL/1.0.1e'
```

The banner is sample text sent by this local test server; it does not claim
that OpenSSL is installed. Keep this terminal open. The server listens on
loopback only. `--host`, `--port`, and `--banner` can be changed; the server
rejects non-loopback bind addresses.

## 3. Run one allowlisted scan

In terminal 2, from the repository directory, use the matching default
allowlist entry:

```sh
npx tsx scripts/local-scan.ts --host 127.0.0.1 --port 2222 --output ./local-scan-results/pi-demo.json
```

To use another private literal address or port, add that exact pair to a copy
of `scripts/local-scan.allowlist.json`, then pass the copy with
`--allowlist ./path/to/your-allowlist.json`. Hostnames, public addresses,
wildcards, CIDRs, and pairs absent from that file are rejected before a socket
is opened.

## 4. Inspect the JSON result

```sh
python3 -m json.tool ./local-scan-results/pi-demo.json
```

`observations` contains the TCP state, latency, raw received banner, and service
identification. `heuristicCveCandidates` is explicitly marked unverified and
contains the match reason and source. A banner match is a research lead, not a
confirmed vulnerability.

## 5. Verify the TCP connection

With terminal 1 still running, check the same loopback port:

```sh
nc -vz 127.0.0.1 2222
```

Stop the banner server with `Ctrl+C` in terminal 1. Raspberry Pi ARM64
hardware was not available for this run, so these commands were checked in the
local development environment but not on a Raspberry Pi.
