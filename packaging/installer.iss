; The Windows installer, built by npm run build:installer with Inno Setup 6
; (https://jrsoftware.org/isinfo.php) from the executable npm run build:exe made.
; It installs for the current user, without asking for administrator rights.
; Running a newer installer updates the installed copy in place.

#define SourceExe AddBackslash(SourcePath) + "..\dist\claude-ide.exe"
#if !FileExists(SourceExe)
  #error Run npm run build:exe first
#endif
; build:exe stamps the executable with the version from package.json.
#define AppVersion GetStringFileInfo(SourceExe, "ProductVersion")

[Setup]
; Identifies the app across versions, so don't change it.
AppId={{936E9273-5D46-4E34-957E-5647F065EF32}
AppName=Claude IDE
AppVersion={#AppVersion}
AppPublisher=Steve Preston
AppPublisherURL=https://github.com/goathollow/claude-ide
AppSupportURL=https://github.com/goathollow/claude-ide/issues
AppUpdatesURL=https://github.com/goathollow/claude-ide/releases
DefaultDirName={autopf}\Claude IDE
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\dist
OutputBaseFilename=claude-ide-setup
SetupIconFile=icon.ico
UninstallDisplayIcon={app}\claude-ide.exe
UninstallDisplayName=Claude IDE
VersionInfoVersion={#AppVersion}
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
; The [Code] below closes a running copy itself and explains what that does.
CloseApplications=no

[Tasks]
Name: desktopicon; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#SourceExe}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
; The app ID matches the one the IDE's notifications use.
Name: "{autoprograms}\Claude IDE"; Filename: "{app}\claude-ide.exe"; AppUserModelID: "ClaudeIDE"
Name: "{autodesktop}\Claude IDE"; Filename: "{app}\claude-ide.exe"; Tasks: desktopicon

[Registry]
; The IDE registers these itself when it first sends a notification (see
; server/notify.js). Registering them here too means clicking a notification
; works from the start, and uninstalling removes them.
Root: HKCU; Subkey: "Software\Classes\claude-ide"; ValueType: string; ValueData: "URL:Claude IDE"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\claude-ide"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\claude-ide\shell\open\command"; ValueType: string; ValueData: """{app}\claude-ide.exe"" ""%1"""
Root: HKCU; Subkey: "Software\Classes\AppUserModelId\ClaudeIDE"; ValueType: string; ValueName: "DisplayName"; ValueData: "Claude IDE"; Flags: uninsdeletekey

[Run]
Filename: "{app}\claude-ide.exe"; Description: "{cm:LaunchProgram,Claude IDE}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; What the IDE unpacks on its first run, and its log.
Type: filesandordirs; Name: "{localappdata}\claude-ide"

[Code]
// Claude IDE keeps running in the background while Claude sessions run in it,
// so Setup and the uninstaller close it before changing its files. Like
// quitting the IDE, that ends those sessions.

// The installed copy's processes, including helpers it runs for its terminals.
function InstalledProcesses(): Variant;
var
  Exe: String;
  Wmi: Variant;
begin
  Exe := ExpandConstant('{app}\claude-ide.exe');
  StringChangeEx(Exe, '\', '\\', True);
  StringChangeEx(Exe, '''', '\''', True);
  Wmi := CreateOleObject('WbemScripting.SWbemLocator');
  Wmi := Wmi.ConnectServer('.', 'root\CIMV2');
  Result := Wmi.ExecQuery('SELECT * FROM Win32_Process WHERE ExecutablePath = ''' + Exe + '''');
end;

function IsRunning(): Boolean;
begin
  try
    Result := InstalledProcesses().Count > 0;
  except
    Result := False;
  end;
end;

// Returns False if the user would rather not close it, or it won't close.
function CloseRunningCopy(Who: String): Boolean;
var
  Processes: Variant;
  I: Integer;
begin
  Result := True;
  if not IsRunning() then Exit;
  if SuppressibleMsgBox('Claude IDE is running. ' + Who + ' will close it, which stops the Claude sessions running in it. You can resume them later from History.',
      mbConfirmation, MB_OKCANCEL, IDOK) <> IDOK then
  begin
    Result := False;
    Exit;
  end;
  try
    Processes := InstalledProcesses();
    for I := 0 to Processes.Count - 1 do
      Processes.ItemIndex(I).Terminate();
  except
  end;
  // Give Windows a moment to release the files.
  for I := 1 to 25 do
  begin
    if not IsRunning() then Exit;
    Sleep(200);
  end;
  Result := not IsRunning();
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  if CloseRunningCopy('Setup') then
    Result := ''
  else
    Result := 'Claude IDE is still running. Close it, then run Setup again.';
end;

function InitializeUninstall(): Boolean;
begin
  Result := CloseRunningCopy('Uninstalling');
end;
