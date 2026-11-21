# Security reporting

Report suspected HeatSynQ vulnerabilities privately to **Colton Jones** at
[cjones@pm.me](mailto:cjones@pm.me). Use a subject such as `HeatSynQ security report`.
Do not put exploit details, credentials or customer data in a public issue or pull request.

Include the affected commit or version, deployment details relevant to reproduction,
expected and actual behavior, and a minimal reproduction using fictional data. Explain
the access needed and the impact you observed. Redact tokens, passwords, personal data
and private records from logs and screenshots; do not send a production database dump.

The maintainer will investigate privately and coordinate a fix and disclosure with the
reporter. If sensitive evidence is necessary, arrange its transfer through the private
contact before sending it. This project does not promise a fixed response time.

## Maintained code

Security work currently targets the `main` branch. There is no supported release series
or backport policy yet. This public source distribution targets fresh public installations. Completed
development and green CI are not a production acceptance decision.

The [dependency audit policy](docs/dependency-audit-policy.md) documents the audit gate.
No audit exception is approved, and a non-null exception file is refused. A passing gate
does not mean every dependency advisory has been eliminated.

Follow the [installation guide](erp/README.md#production-single-box-on-the-shop-network)
for credential provisioning and network exposure, and use an isolated disposable
environment for security reproductions. General defects without security impact go to the
public [issue tracker](https://github.com/CoJoA13/HeatSynQ-public/issues) (`CoJoA13/HeatSynQ-public` on GitHub).
