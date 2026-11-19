'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {helperScript}=require('../server/windows-lan');
const {parseArgs}=require('../server');

test('Windows 单入口参数及局域网准备脚本（不改系统）', {skip:process.platform!=='win32'},()=>{
  assert.deepEqual(parseArgs(['--lan','--no-open','--port','53111']),{lan:true,noOpen:true,port:53111});
  const script=helperScript(String.raw`D:\含 空格\LinkWave.exe`,53111);
  const check=`$taskErrors=$null; $taskTokens=$null; [System.Management.Automation.Language.Parser]::ParseInput([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(script).toString('base64')}')),[ref]$taskTokens,[ref]$taskErrors)|Out-Null; if($taskErrors.Count){$taskErrors|ForEach-Object{$_.Message};exit 1}`;
  const parsed=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(check,'utf16le').toString('base64')],{windowsHide:true,encoding:'utf8'});
  assert.equal(parsed.status,0,parsed.stdout+parsed.stderr);
  const mocks=String.raw`
function Get-NetFirewallRule { [CmdletBinding()]param($Name); [pscustomobject]@{Enabled='True';Direction='Inbound';Action='Allow';Profile=6;Name=$Name} }
function Get-NetFirewallApplicationFilter { [CmdletBinding()]param([Parameter(ValueFromPipeline=$true)]$InputObject); process { [pscustomobject]@{Program='D:\含 空格\LinkWave.exe'} } }
function Get-NetFirewallPortFilter { [CmdletBinding()]param([Parameter(ValueFromPipeline=$true)]$InputObject); process { if($InputObject.Name.EndsWith('-TCP')){[pscustomobject]@{Protocol='TCP';LocalPort='53111'}}else{[pscustomobject]@{Protocol='UDP';LocalPort='53318'}} } }
function Get-NetFirewallAddressFilter { [CmdletBinding()]param([Parameter(ValueFromPipeline=$true)]$InputObject); process { [pscustomobject]@{RemoteAddress='LocalSubnet'} } }
function Start-Process { throw '已有规则不得提升权限' }
function New-NetFirewallRule { throw '已有规则不得写入系统' }
`;
  const checked=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(mocks+script,'utf16le').toString('base64')],{windowsHide:true,encoding:'utf8'});
  assert.equal(checked.status,0,checked.stderr);assert.equal(checked.stdout,'READY');
});
