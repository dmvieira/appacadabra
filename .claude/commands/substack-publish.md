Convert a markdown blog post from `docs/blog/` into a Substack-ready format, outputting HTML to `docs/blog/substack/` and copying to the clipboard.

**Source file (relative to docs/blog/):** $ARGUMENTS

## Context

Substack's editor does not natively support Markdown. The correct method is to convert Markdown to HTML using **pandoc**, then paste the HTML into the Substack editor where it renders with proper formatting.

## Prerequisites

- **pandoc** must be installed. If not found, install with: `winget install --id JohnMacFarlane.Pandoc`
- After install, refresh PATH: `$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")`

## Steps

### 1. Read the source file
- Read `docs/blog/$ARGUMENTS` (e.g., `blog_expanded_preface.md`).
- If the file doesn't exist, list available files in `docs/blog/` and ask the user to pick one.

### 2. Transform the content

Create a clean Substack-ready markdown file at `docs/blog/substack/{source_filename}` with these transformations:

#### a) Mermaid diagrams -> PNG images
Substack does not render Mermaid. Convert each ` ```mermaid ` block to a PNG image using `mermaid-cli`:

1. Extract the Mermaid code from the fenced block and save it to a temp `.mmd` file in `docs/blog/substack/`.
2. Run `npx -y @mermaid-js/mermaid-cli` to render the PNG with transparent background:
   ```powershell
   npx -y @mermaid-js/mermaid-cli -i "docs\blog\substack\temp_diagram.mmd" -o "docs\blog\substack\{diagram_name}.png" -t default -w 1200 -b transparent
   ```
3. Replace the Mermaid fenced block in the markdown with a bold placeholder:
   `**[INSERT IMAGE: {diagram_name}.png]**`
4. Delete the temp `.mmd` file after rendering.
5. After pasting the HTML into Substack, the user manually drags the generated PNG into the editor at the placeholder location.

#### b) Heading levels
- **H1** (`# Title`) → remove from body; note it as the Substack post title.
- **H2** (`## Section`) → keep as `## Section`.
- **H3** (`### Subsection`) → keep as `### Subsection`.
- **H4+** → convert to **bold text** on its own line.

#### c) Horizontal rules
- Remove double `---` separators (used as visual breaks between parts in the multi-part files). Keep single `---` separators.
- If the source file contains multiple blog parts (e.g., `blog_expanded_parts1_3.md`), split at the `## Part N:` boundaries and ask the user which part to export, or export all as separate files.

#### d) Formatting preservation
- **Bold**, *italic*, `inline code`, markdown links, and tables are all preserved. Pandoc handles them.
- Remove any HTML comments from the source file.

#### e) Unicode normalization (critical for Substack)
Substack's paste handler drops several Unicode characters. Normalize these to ASCII **before** running pandoc:

| Unicode | Char | Replacement |
|---------|------|-------------|
| U+2014 | `—` (em-dash) | `--` |
| U+2013 | `–` (en-dash) | `-` |
| U+2018 | `'` (left single quote) | `'` |
| U+2019 | `'` (right single quote / apostrophe) | `'` |
| U+201C | `"` (left double quote) | `"` |
| U+201D | `"` (right double quote) | `"` |
| U+2026 | `…` (ellipsis) | `...` |
| U+2192 | `→` (right arrow) | `->` |

Also reduce excessive em-dash usage in prose: prefer commas, colons, semicolons, or parentheses.

#### f) Images
- If the source references any image paths, convert them to placeholder comments: `<!-- IMAGE: description -->`.

### 3. Add metadata header
At the top of the output markdown file, add a comment block:

```
<!-- 
  SUBSTACK PUBLISH METADATA
  =========================
  Title: {extracted H1 title}
  Subtitle: {first sentence or short summary — max 140 chars}
  Source: docs/blog/{source filename}
  Generated: {current date ISO}
-->
```

### 4. Write the markdown output
- Create `docs/blog/substack/` if it doesn't exist.
- Write the transformed markdown to `docs/blog/substack/{source_filename}`.
- If the source contains multiple parts, write each part to a separate file.

### 5. Convert to HTML with pandoc
Run the following commands (adjust PATH if pandoc was just installed):

```powershell
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
pandoc "docs\blog\substack\{filename}.md" -f markdown -t html -o "docs\blog\substack\{filename}.html"
```

### 6. Copy HTML to clipboard as rich text (CF_HTML)

**Important:** PowerShell's `Set-Clipboard` copies as plain text. Substack needs HTML in the **CF_HTML** clipboard format — the Windows equivalent of `xclip -selection clipboard -t text/html` on Linux.

```powershell
Add-Type -AssemblyName System.Windows.Forms

$html = [System.IO.File]::ReadAllText("docs\blog\substack\{filename}.html", [System.Text.Encoding]::UTF8)

# Build CF_HTML envelope (Windows clipboard HTML format)
$startHtml = "<html><body>`r`n<!--StartFragment-->"
$endHtml = "<!--EndFragment-->`r`n</body></html>"
$headerTemplate = "Version:0.9`r`nStartHTML:0000000000`r`nEndHTML:0000000000`r`nStartFragment:0000000000`r`nEndFragment:0000000000`r`n"
$headerLen = [System.Text.Encoding]::UTF8.GetByteCount($headerTemplate)
$startHtmlBytes = [System.Text.Encoding]::UTF8.GetByteCount($startHtml)
$htmlBytes = [System.Text.Encoding]::UTF8.GetByteCount($html)
$endHtmlBytes = [System.Text.Encoding]::UTF8.GetByteCount($endHtml)

$sH = $headerLen
$sF = $sH + $startHtmlBytes
$eF = $sF + $htmlBytes
$eH = $eF + $endHtmlBytes

$header = "Version:0.9`r`nStartHTML:{0}`r`nEndHTML:{1}`r`nStartFragment:{2}`r`nEndFragment:{3}`r`n" -f $sH.ToString("D10"), $eH.ToString("D10"), $sF.ToString("D10"), $eF.ToString("D10")
$cfHtml = $header + $startHtml + $html + $endHtml

$dataObj = New-Object System.Windows.Forms.DataObject
$dataObj.SetData([System.Windows.Forms.DataFormats]::Html, $cfHtml)
$dataObj.SetData([System.Windows.Forms.DataFormats]::Text, $html)
[System.Windows.Forms.Clipboard]::SetDataObject($dataObj, $true)

Write-Host "HTML copied to clipboard as CF_HTML (text/html)! $($html.Length) chars"
```

### 7. Summary
Output to the user:
- Source file processed
- Output files created (`.md` and `.html`)
- Number of Mermaid diagrams converted
- HTML character count copied to clipboard
- **Instructions**: Go to Substack → New Post → set the Title and Subtitle from metadata → **Ctrl+V** to paste → Preview and publish
- Remind: review `[Diagram:]` sections — optionally generate images at [mermaid.live](https://mermaid.live) and insert them in the Substack editor
