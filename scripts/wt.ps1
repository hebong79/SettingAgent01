<#
.SYNOPSIS
  ParkAgent 병렬 작업용 git worktree 헬퍼 (Windows PowerShell).

.DESCRIPTION
  작업마다 별도 작업 폴더 + 별도 브랜치를 만들어 파일/브랜치 충돌 없이 동시에 편집·테스트한다.
  워크트리는 리포 루트의 형제 폴더(예: ..\ParkAgent-<name>)에 생성된다.

  node_modules 는 gitignore 라 워크트리마다 없다. 기본은 `npm install`(안전),
  -LinkModules 지정 시 메인 리포의 node_modules 를 정션으로 재사용(설치 생략, 빠름).

.EXAMPLE
  scripts\wt.ps1 new plate-fix              # feat/plate-fix 브랜치로 워크트리 생성 + npm install
  scripts\wt.ps1 new plate-fix -LinkModules # 설치 대신 node_modules 정션 재사용(빠름)
  scripts\wt.ps1 new hotfix -Base main      # main 기준으로 분기
  scripts\wt.ps1 list                       # 워크트리 목록
  scripts\wt.ps1 rm plate-fix               # 워크트리 제거(브랜치는 유지)
  scripts\wt.ps1 rm plate-fix -DeleteBranch # 워크트리 + 브랜치까지 제거
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('new', 'list', 'rm')]
  [string]$Cmd,

  [Parameter(Position = 1)]
  [string]$Name,

  [string]$Base = 'HEAD',   # new: 분기 기준(브랜치/커밋)
  [switch]$LinkModules,     # new: node_modules 정션 재사용(설치 생략)
  [switch]$DeleteBranch     # rm: 브랜치까지 삭제
)

$ErrorActionPreference = 'Stop'

$repo     = (git rev-parse --show-toplevel).Trim()
$parent   = Split-Path $repo -Parent
$repoName = Split-Path $repo -Leaf

function Get-WtPath([string]$n) { Join-Path $parent "$repoName-$n" }

switch ($Cmd) {
  'new' {
    if (-not $Name) { throw "이름이 필요합니다: wt new <name>" }
    $branch = "feat/$Name"
    $path   = Get-WtPath $Name
    if (Test-Path $path) { throw "이미 존재: $path" }

    git worktree add -b $branch $path $Base
    if ($LASTEXITCODE -ne 0) { throw "git worktree add 실패" }

    $nm = Join-Path $path 'node_modules'
    if ($LinkModules) {
      # 메인 리포 node_modules 를 정션으로 공유(동일 OS/arch 가정 — 네이티브 모듈 better-sqlite3/sharp 호환).
      # 주의: @parkagent/types 등 워크스페이스 심링크는 '메인' packages 를 가리킨다.
      #       워크트리에서 packages/* 를 편집하려면 -LinkModules 대신 npm install 을 쓸 것.
      $mainNm = Join-Path $repo 'node_modules'
      if (-not (Test-Path $mainNm)) { throw "메인 node_modules 없음 — 먼저 루트에서 npm install" }
      New-Item -ItemType Junction -Path $nm -Target $mainNm | Out-Null
      Write-Host "node_modules 정션 연결(설치 생략): $nm -> $mainNm"
    }
    else {
      Push-Location $path
      try { npm install } finally { Pop-Location }
    }

    Write-Host ""
    Write-Host "✅ 워크트리 생성 완료"
    Write-Host "   경로  : $path"
    Write-Host "   브랜치: $branch (기준 $Base)"
    Write-Host "   다음  : 새 터미널/에디터에서 위 경로를 열어 작업하세요."
  }

  'list' {
    git worktree list
  }

  'rm' {
    if (-not $Name) { throw "이름이 필요합니다: wt rm <name>" }
    $path = Get-WtPath $Name
    # 정션 node_modules 는 worktree remove 가 대상(내부)만 지우도록 먼저 해제(타겟 보호).
    $nm = Join-Path $path 'node_modules'
    if (Test-Path $nm) {
      $item = Get-Item $nm -Force
      if ($item.LinkType -eq 'Junction') {
        # 정션 자체만 제거(타겟=메인 node_modules 는 보존).
        cmd /c "rmdir `"$nm`"" | Out-Null
        Write-Host "node_modules 정션 해제(메인 보존)."
      }
    }
    git worktree remove $path --force
    if ($LASTEXITCODE -ne 0) { throw "git worktree remove 실패" }
    Write-Host "🗑  워크트리 제거: $path"

    if ($DeleteBranch) {
      git branch -D "feat/$Name"
      Write-Host "🗑  브랜치 제거: feat/$Name"
    }
  }
}
