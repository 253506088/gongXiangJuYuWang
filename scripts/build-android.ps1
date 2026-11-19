param([switch]$SkipAssets)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskAndroid = Join-Path $taskRoot 'android'
$taskSdk = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } elseif ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
if (-not (Test-Path -LiteralPath (Join-Path $taskSdk 'platforms\android-35\android.jar'))) { throw 'Android SDK platform 35 is required. Install it using Android Studio SDK Manager.' }
$taskJdkCandidates = @('C:\Program Files\Java\jdk-17', $env:JAVA_HOME, 'C:\Program Files\Android\Android Studio\jbr')
$taskJdk = $taskJdkCandidates | Where-Object { $_ -and (Test-Path -LiteralPath (Join-Path $_ 'bin\javac.exe')) } | Select-Object -First 1
if (-not $taskJdk) { throw 'JDK 17 or newer is required to build Android.' }
$env:JAVA_HOME = $taskJdk
$env:ANDROID_HOME = $taskSdk
$env:ANDROID_SDK_ROOT = $taskSdk
$env:PATH = (Join-Path $taskJdk 'bin') + ';' + $env:PATH
$taskGradleRoot = Join-Path $env:USERPROFILE '.gradle\wrapper\dists\gradle-8.14.3-bin'
$taskGradle = Get-ChildItem -LiteralPath $taskGradleRoot -Recurse -Filter gradle.bat -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
if (-not $taskGradle) {
    $taskTools = Join-Path $taskAndroid '.tools'
    New-Item -ItemType Directory -Force -Path $taskTools | Out-Null
    $taskGradle = Join-Path $taskTools 'gradle-8.14.3\bin\gradle.bat'
    if (-not (Test-Path -LiteralPath $taskGradle)) {
        Write-Host 'Downloading Gradle 8.14.3...'
        $taskZip = Join-Path $taskTools 'gradle-8.14.3-bin.zip'
        Invoke-WebRequest -Uri 'https://services.gradle.org/distributions/gradle-8.14.3-bin.zip' -OutFile $taskZip
        Expand-Archive -LiteralPath $taskZip -DestinationPath $taskTools -Force
    }
}
$taskSdkEscaped = $taskSdk.Replace('\','/').Replace(':','\:')
[System.IO.File]::WriteAllText((Join-Path $taskAndroid 'local.properties'), ('sdk.dir=' + $taskSdkEscaped + "`n"), (New-Object System.Text.UTF8Encoding $false))
if (-not $SkipAssets) {
    $taskAssets = Join-Path $taskAndroid 'app\src\main\assets\www'
    New-Item -ItemType Directory -Force -Path $taskAssets | Out-Null
    Copy-Item -Path (Join-Path $taskRoot 'public\*') -Destination $taskAssets -Recurse -Force
}
Push-Location $taskAndroid
try {
    & $taskGradle --no-daemon --console=plain :app:assembleRelease
    if ($LASTEXITCODE -ne 0) { throw "Android build failed: exit $LASTEXITCODE" }
} finally { Pop-Location }
$taskDist = Join-Path $taskRoot 'dist'
New-Item -ItemType Directory -Force -Path $taskDist | Out-Null
$taskOutput = Join-Path $taskDist '邻波-LinkWave-Android.apk'
Copy-Item -LiteralPath (Join-Path $taskAndroid 'app\build\outputs\apk\release\app-release.apk') -Destination $taskOutput -Force
Write-Host "Android APK ready: $taskOutput"
