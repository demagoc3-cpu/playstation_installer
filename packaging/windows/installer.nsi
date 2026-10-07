Unicode true
!include "MUI2.nsh"
!include "x64.nsh"
!include "LogicLib.nsh"

!ifndef VERSION
  !define VERSION "1.10.7"
!endif
!ifndef PAYLOAD
  !define PAYLOAD "../../dist/windows/payload"
!endif
!ifndef OUTPUT
  !define OUTPUT "../../dist/windows/PackageFlowSetup-${VERSION}-x64.exe"
!endif

Name "PackageFlow"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\PackageFlow"
InstallDirRegKey HKCU "Software\PackageFlow" "InstallDirectory"
RequestExecutionLevel user
SetCompressor /SOLID lzma
Var LauncherArguments
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "PackageFlow"
VIAddVersionKey "FileDescription" "PackageFlow Windows Setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "PackageFlow contributors"

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\PackageFlow.exe"
!define MUI_FINISHPAGE_RUN_TEXT "PackageFlow"
!define MUI_FINISHPAGE_RUN_PARAMETERS "$LauncherArguments"
!define MUI_FINISHPAGE_SHOWREADME ""
!define MUI_FINISHPAGE_SHOWREADME_TEXT "$(DesktopShortcut)"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION CreateDesktopShortcut
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "Russian"
!define MUI_LANGDLL_REGISTRY_ROOT "HKCU"
!define MUI_LANGDLL_REGISTRY_KEY "Software\PackageFlow"
!define MUI_LANGDLL_REGISTRY_VALUENAME "InstallerLanguage"

LangString Busy ${LANG_ENGLISH} "PackageFlow could not stop safely. Finish active jobs and close the setup wizard, then retry. No program files were replaced."
LangString Busy ${LANG_RUSSIAN} "PackageFlow не удалось безопасно остановить. Завершите активные задания и закройте мастер настройки, затем повторите установку. Файлы программы не заменены."
LangString KeepData ${LANG_ENGLISH} "Your library, pairing and settings are kept in LocalAppData\PackageFlow."
LangString KeepData ${LANG_RUSSIAN} "Библиотека, сопряжение и настройки остаются в LocalAppData\PackageFlow."

LangString DesktopShortcut ${LANG_ENGLISH} "Create a desktop shortcut"
LangString DesktopShortcut ${LANG_RUSSIAN} "Добавить ярлык на рабочий стол"

Function CreateDesktopShortcut
  CreateShortcut "$DESKTOP\PackageFlow.lnk" "$INSTDIR\PackageFlow.exe"
FunctionEnd

Function .onInit
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "Local\PackageFlowSetup") p .r1 ?e'
  Pop $0
  ${If} $0 = 183
    MessageBox MB_ICONEXCLAMATION "PackageFlow Setup is already running."
    Abort
  ${EndIf}
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "PackageFlow requires Windows x64."
    Abort
  ${EndIf}
  SetRegView 64
  !insertmacro MUI_LANGDLL_DISPLAY
  ${If} $LANGUAGE == ${LANG_RUSSIAN}
    StrCpy $LauncherArguments "--language=ru"
  ${Else}
    StrCpy $LauncherArguments "--language=en"
  ${EndIf}
FunctionEnd

Section "PackageFlow" Main
  ${If} ${FileExists} "$INSTDIR\PackageFlow.exe"
    ExecWait '"$INSTDIR\PackageFlow.exe" --prepare-update' $0
    ${If} $0 != 0
      MessageBox MB_ICONEXCLAMATION "$(Busy)"
      Abort
    ${EndIf}
    Sleep 1000
  ${EndIf}
  SetOutPath "$INSTDIR"
  File /r /x "*.pdb" "${PAYLOAD}\*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\PackageFlow" "InstallDirectory" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PackageFlow" "DisplayName" "PackageFlow"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PackageFlow" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PackageFlow" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PackageFlow" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PackageFlow" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PackageFlow" "NoRepair" 1
  CreateDirectory "$SMPROGRAMS\PackageFlow"
  CreateShortcut "$SMPROGRAMS\PackageFlow\PackageFlow.lnk" "$INSTDIR\PackageFlow.exe"
  CreateShortcut "$SMPROGRAMS\PackageFlow\Uninstall.lnk" "$INSTDIR\Uninstall.exe"
SectionEnd

Function un.onInit
  SetRegView 64
  !insertmacro MUI_UNGETLANGUAGE
  ExecWait '"$INSTDIR\PackageFlow.exe" --prepare-update' $0
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION "$(Busy)"
    Abort
  ${EndIf}
  Sleep 1000
FunctionEnd

Section "Uninstall"
  Delete "$DESKTOP\PackageFlow.lnk"
  Delete "$SMPROGRAMS\PackageFlow\PackageFlow.lnk"
  Delete "$SMPROGRAMS\PackageFlow\Uninstall.lnk"
  RMDir "$SMPROGRAMS\PackageFlow"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "PackageFlow"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PackageFlow"
  DeleteRegValue HKCU "Software\PackageFlow" "InstallDirectory"
  ; Persistent data and user-selected game folders are deliberately retained.
  RMDir /r "$INSTDIR\runtime"
  RMDir /r "$INSTDIR\server"
  RMDir /r "$INSTDIR\compose"
  Delete "$INSTDIR\PackageFlow.exe"
  Delete "$INSTDIR\PackageFlow.pdb"
  Delete "$INSTDIR\PackageFlow.Core.pdb"
  Delete "$INSTDIR\configure-firewall.ps1"
  Delete "$INSTDIR\release.json"
  Delete "$INSTDIR\LICENSE"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  MessageBox MB_OK "$(KeepData)"
SectionEnd
