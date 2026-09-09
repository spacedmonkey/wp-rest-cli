# Security Policy

## Supported Versions

`wp-rest-cli` is currently pre-1.0. Only the latest published release is supported with security fixes;
please upgrade to the latest version before reporting an issue.

| Version | Supported          |
| ------- | ------------------ |
| latest  | :white_check_mark: |
| older   | :x:                |

## Reporting a Vulnerability

Please **do not** report security vulnerabilities through public GitHub issues.

This CLI handles WordPress credentials and Application Passwords, so if you believe you've found a
security issue - anything from credential handling/logging, to auth bypass, to unsafe handling of
untrusted REST API responses - please report it privately by emailing **spacedmonkey2@gmail.com**.

Please include as much detail as you can: the command/flow that triggers the issue, the version of
`wp-rest-cli` and Node.js you're using, and, if possible, steps to reproduce. We'll aim to acknowledge
reports promptly and keep you updated as the issue is investigated and fixed.
