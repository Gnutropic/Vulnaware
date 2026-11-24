
# VulnAware — Demonstration and Reproduction Guide

## 1. Equipment and Environment

The research experiments were performed using:

- Windows host computer running VMware Workstation
- Kali Linux 2026.1 virtual machine
- Approximately 4 GB RAM allocated to Kali
- Node.js 24.22.2 and npm 12.2.0
- Nmap 7.99
- Python 3
- TypeScript scanner executed using `tsx`
- Loopback networking through `127.0.0.1`

The experiments do not require a Raspberry Pi, external target, or internet-facing vulnerable service.

The standalone scanner does not require the complete Next.js application or PostgreSQL database to run.

## 2. Installation

Clone the source code:

```bash
git clone https://github.com/Gnutropic/Vulnaware.git
cd Vulnaware
npm ci --no-audit --no-fund
```

The local scanning allowlist is located at:

`scripts/local-scan.allowlist.json`

The tested configuration contains:

```json
{
  "targets": [
    {
      "host": "127.0.0.1",
      "port": 2222
    }
  ]
}
```

All tests must be conducted against systems you own or have explicit authorization to test.

## 3. Test Scenarios

### S1 — Authorized TCP Scan with Simulated OpenSSL Banner

**Objective:** Verify that VulnAware can connect to an authorized service, collect its banner, and report a potential CVE candidate.

**Terminal 1 — Start the test server:**

```bash
npx --no-install tsx scripts/local-banner-server.ts \
  --host 127.0.0.1 --port 2222 --banner 'OpenSSL/1.0.1e'
```

Leave Terminal 1 running.

**Terminal 2 — Run the scanner:**

```bash
npx --no-install tsx scripts/local-scan.ts \
  --host 127.0.0.1 --port 2222 \
  --output ./local-scan-results/kali-loopback.json
```

**Inspect the result:**

```bash
python3 -m json.tool ./local-scan-results/kali-loopback.json
```

**Expected observations:**

- TCP state: `up`
- Banner received: `true`
- Raw banner: `OpenSSL/1.0.1e`
- One heuristic candidate: CVE-2014-0160 (Heartbleed)
- Vulnerability verified: `false`

The test server only transmits simulated banner text. This result is not evidence of a real Heartbleed vulnerability.

**Reset:** Press Ctrl+C in Terminal 1 to stop the banner server. Restart it before repeating S1.

### S2 — Unauthorized Target Rejection

**Objective:** Verify that the local scanner rejects an unauthorized IP-and-port combination.

The allowlist permits port 2222, but not port 2223.

Run:

```bash
npx --no-install tsx scripts/local-scan.ts \
  --host 127.0.0.1 --port 2223 \
  --output ./local-scan-results/blocked-port.json
```

**Expected output:**

```text
Local scan rejected or failed: Target pair is not explicitly allowlisted: 127.0.0.1:2223
```

No scan-result file should be created.

To confirm that no connection reaches an independently monitored port, open a separate terminal and run:

```bash
python3 - <<'PY'
import socket

server = socket.socket()
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("127.0.0.1", 2223))
server.listen(1)
server.settimeout(15)

print("Monitoring unauthorized port 2223 for 15 seconds")

try:
    client, address = server.accept()
    print("Unexpected connection from", address)
    client.close()
except socket.timeout:
    print("PASS: No connection received during monitoring")
finally:
    server.close()
PY
```

While the listener is monitoring port 2223, repeat the rejected scan command.

**Expected observations:**

- Scanner rejects the unauthorized host-port combination.
- Listener reports no connection during the monitoring interval.
- No JSON scan report is created.

These observations support the allowlist restriction but do not constitute a packet-level proof.

**Reset:** Allow the monitoring process to exit or press Ctrl+C. Remove any previous blocked-port output before repeating the test:

```bash
rm -f ./local-scan-results/blocked-port.json
```

### S3 — Closed TCP Port Detection

**Objective:** Verify that VulnAware distinguishes a closed TCP port from an open service.

First, stop the local banner server on port 2222 using Ctrl+C.

Run:

```bash
npx --no-install tsx scripts/local-scan.ts \
  --host 127.0.0.1 --port 2222 \
  --output ./local-scan-results/closed-port.json
```

Inspect the result:

```bash
python3 -m json.tool ./local-scan-results/closed-port.json
```

**Expected observations:**

- TCP state: `down`
- Banner received: `false`
- Raw banner: `null`
- Zero heuristic CVE candidates

Nmap baseline:

```bash
nmap -sT -p 2222 127.0.0.1
```

Expected Nmap port state: `closed`.

**Reset:** Restart the banner server before returning to S1.

### S4 — Open TCP Port Without a Banner

**Objective:** Determine whether VulnAware can identify an open service that provides no application-level banner.

Make sure the original banner server on port 2222 has been stopped.

In Terminal 1, run:

```bash
python3 - <<'PY'
import socket
import time

server = socket.socket()
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("127.0.0.1", 2222))
server.listen(5)

print("Silent TCP server listening on 127.0.0.1:2222")

try:
    while True:
        client, address = server.accept()
        time.sleep(1)
        client.close()
except KeyboardInterrupt:
    print("Stopping silent TCP server")
finally:
    server.close()
PY
```

In Terminal 2:

```bash
npx --no-install tsx scripts/local-scan.ts \
  --host 127.0.0.1 --port 2222 \
  --output ./local-scan-results/silent-port.json
```

Inspect:

```bash
python3 -m json.tool ./local-scan-results/silent-port.json
```

**Expected observations:**

- TCP state: `up`
- Banner received: `false`
- Raw banner: `null`
- No service identification from a banner
- Zero heuristic CVE candidates

Nmap baseline:

```bash
nmap -sT -p 2222 127.0.0.1
```

Expected Nmap port state: `open`.

**Reset:** Stop the Python listener with Ctrl+C.

## 4. Repeated-Scan Evaluation

A five-run experiment against the open simulated-banner service produced:

| Tool | Successful open-port detections | Average measured duration |
| --- | --- | --- |
| VulnAware | 5/5 | 154.2 ms |
| Nmap TCP connect scan | 5/5 | 42.0 ms |

VulnAware durations were 154, 154, 155, 154, and 154 milliseconds.

Nmap reported durations were 40, 40, 40, 50, and 40 milliseconds.

These tools use different timing boundaries. The figures are not a controlled end-to-end speed comparison.

A previously observed `ECONNRESET` failure in the test banner server was addressed by adding client socket error handling. The five valid Nmap trials were conducted after this test-server reliability correction.

The repeated-scan evaluation does not establish that VulnAware has equivalent service-detection or vulnerability-detection capabilities to Nmap.

## 5. Known Limitations

- The test banner was simulated.
- No real Heartbleed vulnerability was verified.
- CVE matching is heuristic.
- Silent services may be detected without identification.
- The local runner performs TCP-focused checks, not full HTTP/TLS vulnerability validation.
- Raspberry Pi ARM64 deployment was not tested.
- Results are limited to controlled loopback experiments.

## 6. Demonstration Recording

Video URL: https://drive.google.com/file/d/1DdwOnI43hhhPd--2l9DoJt-GqOItLGZb/view?usp=sharing

The recording is approximately 9 minutes long.


### Demonstration Timestamps

| Scenario | Description | Video Timestamp |
|---|---|---|
| Setup | Kali Linux environment and project directory | 00:00 |
| S1 | Authorized TCP scan with simulated OpenSSL banner | 00:45 |
| S2 | Allowlist enforcement and unauthorized port 2223 rejection | 03:10 |
| S3 | Review of previously recorded closed-port results | 05:35 |
| S4 | Review of previously recorded silent-service results | 06:00 |
| S5 | Nmap TCP connect comparison | 08:10 |

**Recording duration:** 09:08.

**Note:** S3 and S4 display saved JSON results from earlier controlled tests. Their reproduction commands and reset procedures are documented above.

