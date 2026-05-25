Get-CimInstance Win32_Process |
  Where-Object {
    $_.CommandLine -match 'cursor-agent|codex' -and
    $_.CommandLine -notmatch 'chatgpt-26' -and
    $_.CommandLine -notmatch '_diag_'
  } |
  Select-Object ProcessId, ParentProcessId, Name, @{n='Cmd';e={ ($_.CommandLine -replace '\s+', ' ').Substring(0, [Math]::Min(180, $_.CommandLine.Length)) }} |
  Sort-Object ParentProcessId |
  Format-Table -AutoSize
