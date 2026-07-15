# copy_part8_to_clipboard.ps1
# Copies blog_part8.html to the Windows clipboard in CF_HTML format (HTML Format).
# Uses manually calculated UTF-8 byte offsets as required by the CF_HTML spec.

Add-Type -AssemblyName System.Windows.Forms

$htmlFile = Join-Path $PSScriptRoot "..\docs\blog\substack\blog_part8.html"
$rawBytes  = [System.IO.File]::ReadAllBytes($htmlFile)
$rawText   = [System.Text.Encoding]::UTF8.GetString($rawBytes)

# Strip the metadata comment at the top (everything from <!-- to the closing -->)
$content = $rawText -replace '(?s)^<!--.*?-->\r?\n', ''

# Build the full HTML body (what goes between the fragment markers)
# We trim leading/trailing whitespace from the extracted content
$fragmentContent = $content.TrimStart("`r", "`n")

# ---- Build CF_HTML with placeholder offsets (each placeholder = 10 chars) ----
#
# The header block (with placeholders) looks like this:
#   Version:0.9\r\n          (12 bytes)
#   StartHTML:0000000000\r\n  (22 bytes)
#   EndHTML:0000000000\r\n    (20 bytes)
#   StartFragment:0000000000\r\n  (26 bytes)
#   EndFragment:0000000000\r\n    (24 bytes)
#
# Because we use fixed-width 10-digit numbers the header size is constant.
# We calculate offsets based on byte positions in the UTF-8 encoded final string.

$header = "Version:0.9`r`nStartHTML:0000000000`r`nEndHTML:0000000000`r`nStartFragment:0000000000`r`nEndFragment:0000000000`r`n"

$htmlOpen     = "<html>`r`n<body>`r`n"
$fragOpen     = "<!--StartFragment-->`r`n"
$fragClose    = "`r`n<!--EndFragment-->`r`n"
$htmlClose    = "</body>`r`n</html>"

# Assemble the full string (still with placeholder offsets)
$fullText = $header + $htmlOpen + $fragOpen + $fragmentContent + $fragClose + $htmlClose

# --- Calculate byte offsets ---
$enc = [System.Text.Encoding]::UTF8

$headerBytes       = $enc.GetByteCount($header)
$htmlOpenBytes     = $enc.GetByteCount($htmlOpen)
$fragOpenBytes     = $enc.GetByteCount($fragOpen)
$fragmentBytes     = $enc.GetByteCount($fragmentContent)
$fragCloseBytes    = $enc.GetByteCount($fragClose)
$htmlCloseBytes    = $enc.GetByteCount($htmlClose)

$offStartHTML      = $headerBytes
$offStartFragment  = $headerBytes + $htmlOpenBytes + $fragOpenBytes
$offEndFragment    = $offStartFragment + $fragmentBytes
$offEndHTML        = $offStartFragment + $fragmentBytes + $fragCloseBytes + $htmlCloseBytes

# Format as 10-digit zero-padded strings
$fmt = "{0:D10}"
$sStartHTML     = $fmt -f $offStartHTML
$sEndHTML       = $fmt -f $offEndHTML
$sStartFragment = $fmt -f $offStartFragment
$sEndFragment   = $fmt -f $offEndFragment

# Replace placeholders
$cfHtml = $fullText `
    -replace 'StartHTML:0000000000',     "StartHTML:$sStartHTML" `
    -replace 'EndHTML:0000000000',       "EndHTML:$sEndHTML" `
    -replace 'StartFragment:0000000000', "StartFragment:$sStartFragment" `
    -replace 'EndFragment:0000000000',   "EndFragment:$sEndFragment"

# ---- Copy to clipboard ----
$dataObject = New-Object System.Windows.Forms.DataObject
$dataObject.SetData("HTML Format", $cfHtml)
$dataObject.SetData([System.Windows.Forms.DataFormats]::Text, $fragmentContent)
[System.Windows.Forms.Clipboard]::SetDataObject($dataObject, $true)

Write-Host ""
Write-Host "=== Clipboard copy complete ==="
Write-Host "StartHTML     : $sStartHTML"
Write-Host "EndHTML       : $sEndHTML"
Write-Host "StartFragment : $sStartFragment"
Write-Host "EndFragment   : $sEndFragment"
Write-Host ""

# ---- Verify ----
$clip = [System.Windows.Forms.Clipboard]::GetDataObject()
$formats = $clip.GetFormats()
Write-Host "Formats no clipboard: $($formats -join ', ')"
$retrieved = $clip.GetData("HTML Format")
if ($retrieved) {
    Write-Host ""
    Write-Host "Primeiros 500 chars do CF_HTML no clipboard:"
    Write-Host $retrieved.Substring(0, [Math]::Min(500, $retrieved.Length))
} else {
    Write-Host "AVISO: nao foi possivel recuperar 'HTML Format' do clipboard."
}
