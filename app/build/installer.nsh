; Ao desinstalar: remove o início automático e os avisos salvos.
; (Em atualizações de versão, nada disso é apagado.)
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "MonitorAvisos"
    RMDir /r "$APPDATA\monitor-avisos"
  ${endIf}
!macroend
