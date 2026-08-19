Unicode true
RequestExecutionLevel user

!include "MUI2.nsh"

!ifndef VERSION
  !error "VERSION is required"
!endif
!ifndef HOST_BINARY
  !error "HOST_BINARY is required"
!endif
!ifndef HOST_RESOURCES
  !error "HOST_RESOURCES is required"
!endif
!ifndef OUTPUT_FILE
  !error "OUTPUT_FILE is required"
!endif

Name "Velar Host"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\Velar Host"
InstallDirRegKey HKCU "Software\VelarOS\Host" "InstallLocation"

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\Velar Host.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Start Velar Host"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "Velar Host" SEC_HOST
  SetOutPath "$INSTDIR"
  File "/oname=Velar Host.exe" "${HOST_BINARY}"
  SetOutPath "$INSTDIR\resources"
  File /r "${HOST_RESOURCES}\*"

  WriteRegStr HKCU "Software\VelarOS\Host" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Velar Host" "DisplayName" "Velar Host"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Velar Host" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Velar Host" "Publisher" "VelarOS"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Velar Host" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateDirectory "$SMPROGRAMS\VelarOS"
  CreateShortcut "$SMPROGRAMS\VelarOS\Velar Host.lnk" "$INSTDIR\Velar Host.exe"
  CreateShortcut "$DESKTOP\Velar Host.lnk" "$INSTDIR\Velar Host.exe"
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\Velar Host.lnk"
  Delete "$SMPROGRAMS\VelarOS\Velar Host.lnk"
  RMDir "$SMPROGRAMS\VelarOS"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Velar Host"
  DeleteRegKey HKCU "Software\VelarOS\Host"
  RMDir /r "$INSTDIR"
SectionEnd
