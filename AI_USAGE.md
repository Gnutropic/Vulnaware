
# AI Usage Disclosure

## AI Tools Used

### Polsia

Polsia was used to assist in developing the VulnAware application, including its TypeScript/Node.js architecture, scanner components, user interface, and supporting utilities.

The source code was exported from Polsia and evaluated locally using Kali Linux.

### ChatGPT

ChatGPT was used for technical explanations, troubleshooting, experimental planning, interpreting program output, benchmark calculations, and assistance with project documentation and presentation material.

ChatGPT also provided guidance when investigating errors encountered during testing.

## AI-Assisted Files and Components

Polsia assisted with the application source code in `src/`, the scanner components in `src/lib/business/scanner/`, and the standalone scanning utilities in `scripts/`.

ChatGPT assisted with testing procedures, debugging guidance, interpretation of experimental findings, and drafting `README.md`, `DEMO.md`, `AI_USAGE.md`, and portions of the final presentation and research report.

## How the Results Were Verified

The project was tested directly in Kali Linux using controlled TCP services.

The following experiments were performed:

- Authorized TCP port and service banner scanning.
- Unauthorized scan rejection using an exact IP and port allowlist.
- Closed TCP port detection.
- Open TCP port detection without a service banner.
- Five repeated VulnAware scans.
- Five repeated Nmap TCP connect scans.

During testing, an unhandled `ECONNRESET` error caused the local banner server to terminate. The error was investigated using its stack trace and source code. A socket error handler was added and the repeated Nmap tests were completed afterward.

The simulated `OpenSSL/1.0.1e` banner produced a heuristic candidate for CVE-2014-0160 (Heartbleed). This result was not treated as a confirmed vulnerability because the server was only transmitting simulated banner text.

All experimental measurements used in the report were obtained from actual program outputs, not AI-generated estimates.

## Limitations

AI-assisted suggestions were checked against available code and experimental results. The project does not claim to have confirmed a real Heartbleed vulnerability or completed testing on Raspberry Pi hardware.
