/**
 * Body of `s2code.cmd`. Installed updaters only rewrite the legacy `"<t3.exe>" %*` shim, so this
 * reads its line and runs the exe with our own `%*`: `call` would re-parse `%`/`^`, and FOR
 * substitution happens after percent expansion. The legacy line's last four chars are `" %*`.
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
