; Additions to electron-builder's NSIS installer for the K3 test build
; (package.json: build.nsis.include).
;
; The installer is the assisted kind (oneClick: false), for the current user
; only, without administrator rights and without a choice of folder.

; A first page that says what is about to be installed and waits for the
; tester: without it the assisted installer starts copying files the moment it
; opens, before a screen reader has said anything.
!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
!macroend

; Always install for the current user: the "only for me / for everyone" page is
; not shown, and no elevation is asked for.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend
