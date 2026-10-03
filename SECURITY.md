# Security policy

## Supported versions

Security fixes are applied to the latest `1.x` release. Users should upgrade to the newest available release before reporting an issue that may already be fixed.

## Reporting a vulnerability

If private vulnerability reporting is enabled, use the repository's [GitHub Security page](https://github.com/TechyMS/phptinker/security) to report privately. If that option is unavailable, open an issue requesting a private reporting channel without describing the vulnerability, and wait for the maintainer to provide one. Do not include secrets, private keys, production data, or a publicly usable exploit in a public issue. In the private report, include the affected version, operating system, reproduction steps, impact, and any proposed mitigation.

## Trust boundary

PHP Tinker is a local code-execution tool. Pressing **Run** is explicit authorization to execute the current PHP or JavaScript buffer with the current user's permissions. Composer and Laravel modes also load the selected project's `vendor/autoload.php` and, for Laravel, `bootstrap/app.php`. SSH mode executes code on the selected remote host through the system OpenSSH client.

The following actions are designed not to execute selected-project code:

- opening or selecting a project;
- reading Composer JSON metadata;
- indexing PHP files for autocomplete;
- reading a generated Composer classmap as tokens.

The indexer starts the configured PHP interpreter with `-n`, disables prepend/append files, and sends a bundled scanner over stdin. It never includes or evaluates project-controlled Composer PHP maps. Local PHP executable paths are validated absolute paths. A remote PHP setting must be an absolute POSIX path or a bare command name; bare names are resolved to an absolute executable before entering the project directory.

Desktop settings and caches are per-user local files in Electron's `userData` directory. SSH passwords and private-key contents are not stored by the app.

## Security-sensitive changes

Changes to Electron window preferences, preload APIs, IPC handlers, child-process execution, SSH command construction, PHP runtime discovery, or Composer indexing should include focused regression tests. Keep `contextIsolation` and the renderer sandbox enabled, Node integration disabled, navigation and new windows denied, and the Content Security Policy restrictive.
