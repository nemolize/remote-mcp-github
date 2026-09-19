# Issue labels

Maintainers manage this repository's label definitions and synchronization in
[nemolize/github-configs](https://github.com/nemolize/github-configs), a private
repository. Access to that repository is required to use the shared tooling.

From a configured checkout of `github-configs`, preview changes with
`python -m github_configs --repo nemolize/remote-mcp-github`. Add `--apply` to synchronize labels
or `--check` to fail when labels differ from the configuration.

Maintainers coordinate Area dropdown changes in `.github/ISSUE_TEMPLATE/` with
this repository's central label configuration. Synchronize labels before
publishing forms that reference new labels.
