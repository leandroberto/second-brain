# Instala o atalho F1 (apps/desktop, Electron) no Windows, sem admin.
# Copia apps/desktop do repositorio no WSL para uma pasta local, instala, compila, roda os testes e
# cria o atalho de inicializacao do Windows apontando para o Electron dessa pasta.
#
#   .\desktop-install.ps1                       # instala em %LOCALAPPDATA%\second-brain-desktop
#   .\desktop-install.ps1 -Dest C:\tmp\sb -SkipShortcut   # teste: outra pasta e sem atalho de inicializacao
#
# -Distro: distro do WSL; sem ela, usa a distro padrao do WSL (e o second-brain.cmd instalado omite o -d).
# -RepoPath: caminho do clone a partir do home do usuario no WSL; vai tambem para o second-brain.cmd instalado.
#
# O destino e espelhado (robocopy /MIR): o script so aceita uma pasta nova, vazia ou ja instalada por ele
# (marcador .second-brain-desktop), para nunca apagar uma pasta do usuario.
#
# O arquivo e ASCII de proposito: o PowerShell 5.1 le .ps1 sem BOM como ANSI.
[CmdletBinding()]
param(
    [string]$Dest = (Join-Path $env:LOCALAPPDATA 'second-brain-desktop'),
    [switch]$SkipShortcut,
    [string]$Distro,
    [string]$WslUser,
    [string]$RepoPath = 'projetos\second-brain'
)
$ErrorActionPreference = 'Stop'

function Invoke-Passo([string]$Titulo, [scriptblock]$Bloco) {
    Write-Output "==> $Titulo"
    & $Bloco
    if ($LASTEXITCODE -ne 0) { throw "Falhou: $Titulo (codigo $LASTEXITCODE)" }
}

# 1) o destino: so pasta nova, vazia ou instalada por este script (o /MIR apaga o que nao vem do repositorio)
$marcador = Join-Path $Dest '.second-brain-desktop'
if (Test-Path -LiteralPath $Dest) {
    if (-not (Test-Path -LiteralPath $Dest -PathType Container)) { throw "-Dest aponta para um arquivo, nao uma pasta: $Dest" }
    $temAlgo = @(Get-ChildItem -LiteralPath $Dest -Force | Select-Object -First 1).Count -gt 0
    if ($temAlgo -and -not (Test-Path -LiteralPath $marcador)) {
        # instalacao feita antes do marcador existir: reconhecida pelo package.json do proprio desktop
        $pkg = Join-Path $Dest 'package.json'
        $nossa = (Test-Path -LiteralPath $pkg) -and ([IO.File]::ReadAllText($pkg) -match '"name"\s*:\s*"@brain/desktop"')
        if (-not $nossa) {
            throw "Recusado: a pasta '$Dest' nao esta vazia e nao foi criada por este instalador (falta o marcador .second-brain-desktop). A instalacao espelha a pasta (robocopy /MIR) e apagaria o que esta nela. Use em -Dest uma pasta nova ou vazia."
        }
    }
}

# 2) a origem no WSL
$wslArgs = @()
if ($Distro) { $wslArgs = @('-d', $Distro) }
$distroUnc = $Distro
if (-not $distroUnc) {
    $distroUnc = ((wsl.exe -e sh -c 'echo $WSL_DISTRO_NAME') | Out-String).Trim()
    if (-not $distroUnc) { throw 'Nao consegui descobrir a distro padrao do WSL. Passe -Distro.' }
}
if (-not $WslUser) {
    $WslUser = ((wsl.exe @wslArgs -e whoami) | Out-String).Trim()
    if (-not $WslUser) { throw "Nao consegui descobrir o usuario do WSL na distro '$distroUnc'. Passe -WslUser." }
}
$repo = "\\wsl.localhost\$distroUnc\home\$WslUser\$RepoPath"
$origem = Join-Path $repo 'apps\desktop'
if (-not (Test-Path $origem)) { throw "Nao achei $origem. Confira -Distro, -WslUser e -RepoPath." }

Write-Output "Origem:  $origem"
Write-Output "Destino: $Dest"
New-Item -ItemType Directory -Force $Dest | Out-Null
# /MIR espelha o codigo; node_modules, dist, o marcador e o .cmd ficam de fora (nem copiados, nem apagados no destino)
robocopy $origem $Dest /MIR /XD node_modules dist /XF .second-brain-desktop second-brain.cmd /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy falhou (codigo $LASTEXITCODE)" }
[IO.File]::WriteAllText($marcador, "Pasta gerenciada pelo desktop-install.ps1 do second-brain: a reinstalacao espelha esta pasta (robocopy /MIR).`r`n")

# usado pelo botao "Iniciar second-brain" das notificacoes
$cmdDestino = Join-Path $Dest 'second-brain.cmd'
Copy-Item (Join-Path $repo 'scripts\windows\second-brain.cmd') $cmdDestino -Force
# grava a distro (-Distro; vazia = padrao do WSL) e o clone (-RepoPath) escolhidos na copia do .cmd
$repoWsl = '~/' + ($RepoPath -replace '\\', '/')
$conteudo = [IO.File]::ReadAllText($cmdDestino)
foreach ($par in @(@('DISTRO', $Distro), @('REPO', $repoWsl))) {
    $re = '(?m)^set "' + $par[0] + '=[^"\r\n]*"'
    if (([regex]::Matches($conteudo, $re)).Count -ne 1) { throw "second-brain.cmd sem a linha set `"$($par[0])=...`" esperada" }
    $conteudo = [regex]::Replace($conteudo, $re, ('set "' + $par[0] + '=' + $par[1] + '"').Replace('$', '$$'))
}
[IO.File]::WriteAllText($cmdDestino, $conteudo, (New-Object Text.UTF8Encoding $false))

Push-Location $Dest
try {
    # a rede corporativa faz inspecao TLS: o Node precisa confiar nos certificados do Windows
    $env:NODE_OPTIONS = '--use-system-ca'
    Invoke-Passo 'npm install (compila no postinstall)' { npm install }
    Invoke-Passo 'npm run build' { npm run build }
    Invoke-Passo 'npx vitest run' { npx vitest run }
    # o install-electron baixa o binario se o postinstall do Electron foi bloqueado pela rede
    $exe = Join-Path $Dest 'node_modules\electron\dist\electron.exe'
    if (-not (Test-Path $exe)) { Invoke-Passo 'npx install-electron --no' { npx install-electron --no } }
    if (-not (Test-Path $exe)) { throw "electron.exe nao encontrado em $exe" }
}
finally { Pop-Location }

if ($SkipShortcut) {
    Write-Output 'Atalho de inicializacao: ignorado (-SkipShortcut).'
} else {
    $startup = [Environment]::GetFolderPath('Startup')
    $lnk = Join-Path $startup 'Second Brain Desktop.lnk'
    $sh = New-Object -ComObject WScript.Shell
    $s = $sh.CreateShortcut($lnk)
    $s.TargetPath = $exe
    $s.Arguments = "`"$Dest`""
    $s.WorkingDirectory = $Dest
    $s.Description = 'Second Brain: atalho F1 para anotar e perguntar'
    $s.Save()
    Write-Output "Atalho de inicializacao criado: $lnk"
}
Write-Output "Pronto. Rode 'brain pair-desktop' no WSL, copie o token e use 'Parear' no menu da bandeja."
