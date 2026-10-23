/**
 * Body of the canonical Windows command (`s2code.cmd`).
 *
 * The legacy command stays a direct `"<t3.exe>" %*` shim because installed
 * updaters only rewrite that file. This one reads that line and runs the exe
 * with its own `%*`, so an old updater is still followed and arguments are
 * parsed once. `call "<legacy>.cmd" %*` parses `%` and `^` a second time.
 * Putting the legacy line in `for /f ... do %%L` does not expand `%*` either:
 * FOR substitution happens after percent expansion, so `%*` has to be source
 * text in this file. The last four characters of the legacy line are `" %*`.
 */
export function windowsForwarderShim(legacyCommand: string): string {
  return [
    "@echo off",
    "setlocal DisableDelayedExpansion",
    'set "s2_line="',
    `for /f "usebackq skip=1 delims=" %%L in ("${legacyCommand}") do set "s2_line=%%L"`,
    "if not defined s2_line exit /b 1",
    'set "s2_exe=%s2_line:~1,-4%"',
    "if not defined s2_exe exit /b 1",
    'endlocal & "%s2_exe%" %*',
    "exit /b %ERRORLEVEL%",
  ].join("\r\n");
}
