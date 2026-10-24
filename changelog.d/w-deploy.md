### Fixed

- **Deploys refuse to reuse a release version for a different tree** (CAIRN-435, CAIRN-436). The version guard runs before the deploy job starts, keeping the server's advertised CLI and the files agents sync from its tag in step; cut and publish the next release to deploy new code.
