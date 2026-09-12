# Security Policy

## Supported Versions

Wcash Warden is currently an unsigned Testnet engineering build. Only the latest
published Testnet build is eligible for security fixes; older builds are not
backported.

| Platform | Supported |
| -------- | --------- |
| Latest   | ✓         |
| Older    | ✗         |

## Reporting a Vulnerability

If you believe you have found a security vulnerability in Wcash Warden, please
**do not open a public GitHub issue**. Report it privately to the repository
maintainer:

**Email:** placex.com@gmail.com

Please include as much of the following as possible:

- A clear description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept
- Affected version(s) and operating system(s)
- Any suggested mitigations

Never include a seed phrase, spending key, wallet database, authentication
credential, or other secret in a report. Use an isolated Testnet wallet for any
reproduction material.

## Scope

Issues considered in scope:

- Private key or seed phrase exposure
- Unauthorized fund transfer or transaction signing
- Authentication or authorization bypasses
- Cryptographic weaknesses in wallet or shielded transaction handling
- Remote code execution via Electron IPC or renderer process escalation
- Node.js / Electron context isolation bypasses leading to privilege escalation
- Data exfiltration affecting wallet users

Out of scope:

- Denial of service against the lightwalletd server
- Issues in third-party dependencies not directly introduced by this project
- Social engineering or phishing attacks
- Reports already publicly known

## Disclosure Policy

Please allow time to reproduce, fix, and distribute a corrected build before
public disclosure. A specific disclosure date will be agreed with the reporter
after the initial assessment.
