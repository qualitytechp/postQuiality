!include "nsDialogs.nsh"

!ifndef BUILD_UNINSTALLER
Var Flo_PasswordInput
!endif

!macro customWelcomePage
  Page custom Flo_PasswordPageCreate Flo_PasswordPageLeave
  !insertmacro MUI_PAGE_WELCOME
!macroend

; Silent installs (/S) skip Page functions entirely, so the password must be
; re-checked here via a /PASSWORD= command-line switch to avoid a bypass.
!macro customInit
  ${If} ${Silent}
    ${GetParameters} $R0
    ClearErrors
    ${GetOptions} $R0 "/PASSWORD=" $R1
    ${If} ${Errors}
    ${OrIf} $R1 != "mamian2026"
      MessageBox MB_OK|MB_ICONSTOP "Se requiere la contrasena de instalacion. Usa /PASSWORD=<clave> con la instalacion silenciosa."
      Quit
    ${EndIf}
  ${EndIf}
!macroend

!ifndef BUILD_UNINSTALLER
Function Flo_PasswordPageCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u "Este instalador esta protegido. Ingresa la contrasena para continuar:"
  Pop $1

  ${NSD_CreatePassword} 0 30u 100% 14u ""
  Pop $Flo_PasswordInput
  ${NSD_SetFocus} $Flo_PasswordInput

  nsDialogs::Show
FunctionEnd

Function Flo_PasswordPageLeave
  ${NSD_GetText} $Flo_PasswordInput $0
  ${If} $0 != "mamian2026"
    MessageBox MB_OK|MB_ICONEXCLAMATION "Contrasena incorrecta. Intenta de nuevo."
    Abort
  ${EndIf}
FunctionEnd
!endif
