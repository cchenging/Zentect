# StepPanel.tsx - Add import + replace inline step nav
$path = "F:\Tools\Zentect\src\renderer\src\pages\editor\components\StepPanel.tsx"
$c = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)

# Add StepIndicator import after StatusIcon import
if ($c -notmatch "StepIndicator") {
    $c = $c -replace "(import \{[^}]*StatusIcon[^}]*\} from '[^']*';)", "`$1`r`nimport { StepIndicator } from '../../../components/shared/StepIndicator';"
    Write-Host "StepPanel: import added"
}

# Replace inline STEPS.map with StepIndicator - find the block and replace
$oldBlockStart = "          {STEPS.map((step, i) => ("
$idx = $c.IndexOf($oldBlockStart)
if ($idx -gt 0) {
    # Find the end of the map block - look for the closing )) followed by newline
    $searchStart = $idx + $oldBlockStart.Length
    $parenDepth = 2  # we're inside ((step, i) => (
    $endIdx = $searchStart
    for ($i = $searchStart; $i -lt $c.Length; $i++) {
        if ($c[$i] -eq '(') { $parenDepth++ }
        if ($c[$i] -eq ')') { $parenDepth-- }
        if ($parenDepth -le 0) { $endIdx = $i + 1; break }
    }
    # Skip trailing whitespace
    while ($endIdx -lt $c.Length -and ($c[$endIdx] -match '[\s\r\n]')) { $endIdx++ }
    
    $replacement = "          <StepIndicator currentStep={currentStep} steps={STEPS} stepStatuses={stepStatuses as any} stepCompleted={stepCompleted} onStepClick={handleStepClick} />`r`n        "
    
    $c = $c.Substring(0, $idx) + $replacement + $c.Substring($endIdx)
    [System.IO.File]::WriteAllText($path, $c, [System.Text.Encoding]::UTF8)
    Write-Host "StepPanel: step nav replaced ($($c.Length) bytes)"
} else {
    Write-Host "StepPanel: STEPS.map not found (maybe already replaced)"
}

# StepScriptGeneration.tsx - Add import + replace R/S/T/P sliders with ParameterSlider
$path2 = "F:\Tools\Zentect\src\renderer\src\pages\editor\components\steps\StepScriptGeneration.tsx"
$c2 = [System.IO.File]::ReadAllText($path2, [System.Text.Encoding]::UTF8)

if ($c2 -notmatch "ParameterSlider") {
    $c2 = $c2 -replace "(import \{[^}]*\} from '[^']*shared';)", "`$1`r`nimport { ParameterSlider } from '../../../../components/shared/ParameterSlider';"
    
    # Replace the 4 slider divs - find the R/S/T/P block
    $rstpStart = $c2.IndexOf("{(['R', 'S', 'T', 'P'] as const).map(param =>")
    if ($rstpStart -gt 0) {
        # Find closing })) 
        $searchStart2 = $rstpStart
        $depth2 = 0
        $endIdx2 = $searchStart2
        for ($i = $searchStart2; $i -lt $c2.Length; $i++) {
            if ($c2[$i] -eq '{') { $depth2++ }
            if ($c2[$i] -eq '}') { $depth2--; if ($depth2 -le 0) { $endIdx2 = $i + 1; break } }
        }
        while ($endIdx2 -lt $c2.Length -and ($c2[$endIdx2] -match '[\s\r\n]')) { $endIdx2++ }
        
        $rstpReplacement = @"
        <ParameterSlider label={param === 'R' ? '经典保留' : param === 'S' ? '原台词保留' : param === 'T' ? 'TTS覆盖' : '节奏因子'} code={param} value={pipelineParams[param]} onChange={(v) => setPipelineParams({ ...pipelineParams, [param]: v })} disabled={isGenerating} unit="%" />
"@
        $c2 = $c2.Substring(0, $rstpStart) + $rstpReplacement + $c2.Substring($endIdx2)
    }
    [System.IO.File]::WriteAllText($path2, $c2, [System.Text.Encoding]::UTF8)
    Write-Host "StepScriptGen: ParameterSlider connected ($($c2.Length) bytes)"
}

# StepShotMatching.tsx - Add DragReorderList import
$path3 = "F:\Tools\Zentect\src\renderer\src\pages\editor\components\steps\StepShotMatching.tsx"
$c3 = [System.IO.File]::ReadAllText($path3, [System.Text.Encoding]::UTF8)
if ($c3 -notmatch "DragReorderList") {
    $c3 = $c3 -replace "(import \{[^}]*\} from '[^']*shared';)", "`$1`r`nimport { DragReorderList } from '../../../../components/shared/DragReorderList';"
    [System.IO.File]::WriteAllText($path3, $c3, [System.Text.Encoding]::UTF8)
    Write-Host "StepShotMatch: DragReorderList import added ($($c3.Length) bytes)"
}

# StepTTSSynthesis.tsx - Add VoiceCard import
$path4 = "F:\Tools\Zentect\src\renderer\src\pages\editor\components\steps\StepTTSSynthesis.tsx"
$c4 = [System.IO.File]::ReadAllText($path4, [System.Text.Encoding]::UTF8)
if ($c4 -notmatch "VoiceCard") {
    $c4 = $c4 -replace "(import \{[^}]*\} from '[^']*shared';)", "`$1`r`nimport { VoiceCard } from '../../../../components/shared/VoiceCard';"
    [System.IO.File]::WriteAllText($path4, $c4, [System.Text.Encoding]::UTF8)
    Write-Host "StepTTSSynth: VoiceCard import added ($($c4.Length) bytes)"
}

# storeTypes.ts - Add entity type imports and replace any[] with typed arrays
$path5 = "F:\Tools\Zentect\src\renderer\src\store\storeTypes.ts"
$c5 = [System.IO.File]::ReadAllText($path5, [System.Text.Encoding]::UTF8)
if ($c5 -notmatch "from '\.\./\.\./shared/types/entities/editor'") {
    $c5 = $c5 -replace "(^import .*?;)", "`$1`r`nimport type { AsrLine, VlmFrame, ScriptParagraph, TtsResult, MatchResult } from '../../shared/types/entities/editor';" -replace "^import ", "import "
    # Replace any[] with typed arrays
    $c5 = $c5 -replace "asrLines:\s*any\[\]", "asrLines: AsrLine[]"
    $c5 = $c5 -replace "vlmFrames:\s*any\[\]", "vlmFrames: VlmFrame[]"
    $c5 = $c5 -replace "scriptParagraphs:\s*any\[\]", "scriptParagraphs: ScriptParagraph[]"
    $c5 = $c5 -replace "ttsResults:\s*any\[\]", "ttsResults: TtsResult[]"
    $c5 = $c5 -replace "matchResults:\s*any\[\]", "matchResults: MatchResult[]"
    [System.IO.File]::WriteAllText($path5, $c5, [System.Text.Encoding]::UTF8)
    Write-Host "storeTypes: any[] replaced with Entity types ($($c5.Length) bytes)"
}

Write-Host "All edits done"