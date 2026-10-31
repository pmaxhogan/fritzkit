param([string]$Out, [int]$X = 0, [int]$Y = 0, [int]$W = 0, [int]$H = 0)
# DPI-aware screenshot so pixel coordinates equal AutoHotkey's screen coordinates.
Add-Type -TypeDefinition @"
using System.Runtime.InteropServices;
public static class Dpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }
"@
[void][Dpi]::SetProcessDPIAware()
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
if ($W -le 0) { $W = $b.Width - $X }
if ($H -le 0) { $H = $b.Height - $Y }
$bmp = New-Object System.Drawing.Bitmap $W, $H
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen((New-Object System.Drawing.Point $X, $Y), [System.Drawing.Point]::Empty, (New-Object System.Drawing.Size $W, $H))
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "saved $Out ${W}x${H} at $X,$Y (screen $($b.Width)x$($b.Height))"
