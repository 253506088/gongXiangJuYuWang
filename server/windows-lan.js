'use strict';
const {spawn}=require('node:child_process');
const crypto=require('node:crypto');
const path=require('node:path');

function firewallDefinitions(executable,port) {
  const data={program:path.resolve(executable),port:Number(port),name:'LinkWave-'+crypto.createHash('sha256').update(path.resolve(executable).toLowerCase()+':'+port).digest('hex').slice(0,16)};
  const payload=Buffer.from(JSON.stringify(data)).toString('base64');
  return `
$ErrorActionPreference = 'Stop'
$taskConfig = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
function Test-LinkWaveRule($taskName, $taskProtocol, $taskPort) {
  $taskRule = Get-NetFirewallRule -Name $taskName -ErrorAction SilentlyContinue
  if (-not $taskRule -or $taskRule.Enabled -ne 'True' -or $taskRule.Direction -ne 'Inbound' -or $taskRule.Action -ne 'Allow') { return $false }
  $taskApplication = $taskRule | Get-NetFirewallApplicationFilter
  $taskPorts = $taskRule | Get-NetFirewallPortFilter
  $taskAddresses = $taskRule | Get-NetFirewallAddressFilter
  return $taskApplication.Program -eq $taskConfig.program -and [string]$taskPorts.Protocol -eq $taskProtocol -and [string]$taskPorts.LocalPort -eq [string]$taskPort -and [string]$taskAddresses.RemoteAddress -eq 'LocalSubnet' -and [int]$taskRule.Profile -eq 6
}
function Test-LinkWaveLan {
  return (Test-LinkWaveRule ($taskConfig.name + '-TCP') 'TCP' $taskConfig.port) -and (Test-LinkWaveRule ($taskConfig.name + '-UDP') 'UDP' 53318)
}
function Set-LinkWaveLan {
  foreach ($taskEntry in @(@{suffix='TCP';protocol='TCP';port=$taskConfig.port}, @{suffix='UDP';protocol='UDP';port=53318})) {
    $taskName = $taskConfig.name + '-' + $taskEntry.suffix
    if (Test-LinkWaveRule $taskName $taskEntry.protocol $taskEntry.port) { continue }
    Get-NetFirewallRule -Name $taskName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction Stop
    New-NetFirewallRule -Name $taskName -DisplayName ('LinkWave LAN ' + $taskEntry.suffix) -Direction Inbound -Action Allow -Program $taskConfig.program -Protocol $taskEntry.protocol -LocalPort $taskEntry.port -RemoteAddress LocalSubnet -Profile Private,Public | Out-Null
  }
}
`;
}

function helperScript(executable,port) {
  // No paths are interpolated into PowerShell code; JSON is decoded as data.
  const definitions=firewallDefinitions(executable,port);
  const elevated=definitions+'\nSet-LinkWaveLan\nif (-not (Test-LinkWaveLan)) { exit 1 }\n';
  const encoded=Buffer.from(elevated,'utf16le').toString('base64');
  return definitions+`
try {
  if (Test-LinkWaveLan) { [Console]::Write('READY'); exit 0 }
  $taskIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $taskPrincipal = New-Object Security.Principal.WindowsPrincipal($taskIdentity)
  if ($taskPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Set-LinkWaveLan
  } else {
    try {
      $taskHelper = Start-Process -FilePath powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','${encoded}') -Wait -PassThru
      if ($taskHelper.ExitCode -ne 0) { [Console]::Write('FAILED'); exit 0 }
    } catch { [Console]::Write('DECLINED'); exit 0 }
  }
  if (Test-LinkWaveLan) { [Console]::Write('READY') } else { [Console]::Write('FAILED') }
} catch { [Console]::Write('FAILED') }
`;
}

async function ensureWindowsLan(port,options={}) {
  if(process.platform!=='win32')return 'not-windows';
  const executable=options.executable||process.execPath;
  console.log('  正在准备局域网连接；首次使用请允许 Windows 管理员授权。');
  const encoded=Buffer.from(helperScript(executable,port),'utf16le').toString('base64');
  const result=await new Promise(resolve=>{
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',encoded],{windowsHide:true,stdio:['ignore','pipe','ignore']});let output='';
    child.stdout.on('data',chunk=>output+=chunk.toString());
    const timer=setTimeout(()=>{child.kill();resolve('FAILED');},150000);timer.unref();
    child.on('error',()=>{clearTimeout(timer);resolve('FAILED');});child.on('exit',()=>{clearTimeout(timer);resolve(output.trim());});
  });
  if(result==='READY')console.log('  局域网已就绪：自动发现与文件连接已允许（仅本地子网）。');
  else console.log('  程序全部功能已启动。若其他设备无法连接，请右键同一个“启动Windows.bat”以管理员身份运行。');
  return result;
}
module.exports={ensureWindowsLan,helperScript};
